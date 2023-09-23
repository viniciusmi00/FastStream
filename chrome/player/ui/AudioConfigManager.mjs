import {EventEmitter} from '../modules/eventemitter.mjs';
import {InterfaceUtils} from '../utils/InterfaceUtils.mjs';
import {StringUtils} from '../utils/StringUtils.mjs';
import {Utils} from '../utils/Utils.mjs';
import {WebUtils} from '../utils/WebUtils.mjs';
import {DOMElements} from './DOMElements.mjs';

export class AudioEQNode {
  constructor(type, frequency, gain, q) {
    this.type = type;
    this.frequency = parseFloat(frequency);
    this.gain = parseFloat(gain);
    this.q = q;
  }

  static fromObj(obj) {
    return new AudioEQNode(obj.type, obj.frequency, obj.gain, obj.q);
  }

  toObj() {
    return {
      type: this.type,
      frequency: this.frequency,
      gain: this.gain,
      q: this.q,
    };
  }
}

export class AudioChannelControl {
  constructor(channelId, gain, muted, solo) {
    this.id = parseInt(channelId);
    this.gain = parseFloat(gain);
    this.muted = muted;
    this.solo = solo;
  }

  static fromObj(obj) {
    return new AudioChannelControl(obj.id, obj.gain, obj.muted, obj.solo);
  }

  toObj() {
    return {
      id: this.id,
      gain: this.gain,
      muted: this.muted,
      solo: this.solo,
    };
  }
}

export class AudioProfile {
  constructor(id) {
    this.id = parseInt(id);
    this.equalizerNodes = [];
    this.mixerChannels = [];
    this.label = `Profile ${id}`;
  }

  static fromObj(obj) {
    const profile = new AudioProfile(obj.id);
    profile.label = obj.label;
    profile.equalizerNodes = obj.equalizerNodes?.map((nodeObj) => {
      return AudioEQNode.fromObj(nodeObj);
    }) || [];
    profile.mixerChannels = obj.mixerChannels?.map((channelObj) => {
      return AudioChannelControl.fromObj(channelObj);
    }) || [];
    return profile;
  }

  copy() {
    return AudioProfile.fromObj(this.toObj());
  }

  toObj() {
    return {
      id: this.id,
      label: this.label,
      equalizerNodes: this.equalizerNodes.map((node) => {
        return node.toObj();
      }),
      mixerChannels: this.mixerChannels.map((channel) => {
        return channel.toObj();
      }),
    };
  }
}

export class AudioConfigManager extends EventEmitter {
  constructor(client) {
    super();
    this.client = client;
    this.profiles = [];
    this.ui = {};

    this.setupUI();

    this.renderLoopRunning = false;
    this.shouldRunRenderLoop = false;

    this.equalizerNodes = [];
    this.loadProfilesFromStorage();
  }

  loadProfilesFromStorage() {
    chrome.storage.local.get({
      audioProfiles: '[]',
      currentAudioProfile: -1,
    }, (data) => {
      const audioProfiles = JSON.parse(data.audioProfiles) || [];
      const currentAudioProfileID = data.currentAudioProfile || -1;

      if (audioProfiles.length === 0) {
        this.newProfile();
        this.setCurrentProfile(this.profiles[0]);
      } else {
        this.profiles = audioProfiles.map((profile) => {
          return AudioProfile.fromObj(profile);
        });
        const currentProfile = this.profiles.find((profile) => profile.id === currentAudioProfileID);
        if (currentProfile) {
          this.setCurrentProfile(currentProfile);
        } else {
          this.setCurrentProfile(this.profiles[0]);
        }
        this.updateProfileDropdown();
      }
      this.refreshEQNodes();
      this.refreshMixer();
    });
  }

  saveProfilesToStorage() {
    clearTimeout(this.saveTimeout);
    this.saveTimeout = setTimeout(() => {
      chrome.storage.local.set({
        audioProfiles: JSON.stringify(this.profiles.map((profile) => profile.toObj())),
        currentAudioProfile: this.currentProfile?.id || this.profiles[0]?.id || 0,
      });
    }, 500);
  }

  getNextProfileID() {
    let id = 1;
    // Really bad code
    while (this.profiles.find((profile) => profile.id === id)) {
      id++;
    }

    return id;
  }

  newProfile() {
    const newID = this.getNextProfileID();
    const profile = new AudioProfile(newID);
    this.addProfile(profile);

    Array.from(this.ui.profileDropdown.children[1].children).find((el) => el.dataset.val === 'p' + newID).click();
  }

  loadProfileFile(obj) {
    if (obj.type !== 'audioProfile') {
      throw new Error('Invalid profile type');
    }

    obj.profiles.forEach((profileObj) => {
      const profile = AudioProfile.fromObj(profileObj);
      profile.id = this.getNextProfileID();

      if (this.profiles.some((test) => test.label === profile.label)) {
        profile.label = profile.label + ` (loaded from file on ${(new Date()).toDateString()})`;
      }

      this.profiles.push(profile);
    });
    this.updateProfileDropdown();
    this.saveProfilesToStorage();
  }

  addProfile(profile) {
    this.profiles.push(profile);
    this.updateProfileDropdown();
    this.saveProfilesToStorage();
  }

  setCurrentProfile(profile) {
    this.currentProfile = profile.copy();
    this.saveProfilesToStorage();
  }

  deleteProfile(profile) {
    const index = this.profiles.indexOf(profile);
    if (index !== -1) this.profiles.splice(index, 1);

    if (this.profiles.length === 0) {
      this.newProfile();
    }

    this.updateProfileDropdown();

    Array.from(this.ui.profileDropdown.children[1].children).find((el) =>
      el.dataset.val === 'p' + this.profiles[Math.max(0, index - 1)].id,
    ).click();

    this.saveProfilesToStorage();
  }

  updateProfileDropdown(defaultID = null) {
    const oldDropdown = this.ui.profileDropdown;

    const optionsList = {};

    this.profiles.forEach((profile) => {
      optionsList['p' + profile.id] = profile.label;
    });

    optionsList['create'] = 'Create new profile';
    optionsList['import'] = 'Import profiles from file';

    let id = defaultID !== null ? defaultID : (this.currentProfile?.id || 0);
    if (!this.profiles.find((profile) => profile.id === id)) {
      id = this.profiles[0]?.id || 0;
    }

    this.ui.profileDropdown = WebUtils.createDropdown('p' + id,
        'Profile', optionsList, (val, prevVal) => {
          if (val === 'create') {
            this.newProfile();
          } else if (val === 'import') {
            this.updateProfileDropdown(parseInt(prevVal.substring(1)));
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.json';
            input.addEventListener('change', () => {
              const file = input.files[0];
              if (!file) return;
              const reader = new FileReader();
              reader.onload = (e) => {
                try {
                  const obj = JSON.parse(e.target.result);
                  this.loadProfileFile(obj);
                } catch (e) {
                  alert('Invalid profile file');
                }
              };
              reader.readAsText(file);
            });
            input.click();
          }
        }, (key, displayName)=>{
          if (key === 'create' || key === 'import') {
            return;
          }

          displayName = displayName.replaceAll('\n', ' ').trim();

          if (displayName.length === 0) {
            displayName = 'Unnamed Profile';
          }

          const profile = this.profiles.find((profile) => profile.id === parseInt(key.substring(1)));
          if (profile) {
            profile.label = displayName;
            this.saveProfilesToStorage();
          }
        },
    );

    this.ui.profileDropdown.children[0].children[0].addEventListener('blur', ()=>{
      this.updateProfileDropdown(parseInt(this.ui.profileDropdown.dataset.val.substring(1)));
    });

    this.ui.profileDropdown.classList.add('profile_selector');
    this.ui.profileManager.replaceChild(this.ui.profileDropdown, oldDropdown);
  }

  openUI() {
    InterfaceUtils.closeWindows();
    DOMElements.audioConfigContainer.style.display = '';
    this.startRenderLoop();
  }

  closeUI() {
    DOMElements.audioConfigContainer.style.display = 'none';
    this.stopRenderLoop();
  }

  saveCurrentProfile() {
    const profile = this.getDropdownProfile();
    if (!profile) {
      this.updateProfileDropdown();
      alert('Couldn\'t save profile');
      return;
    }

    const newProfile = this.currentProfile.copy();
    newProfile.label = profile.label;
    newProfile.id = profile.id;

    const index = this.profiles.indexOf(profile);
    if (index !== -1) this.profiles.splice(index, 1, newProfile);

    this.updateProfileDropdown();
    this.saveProfilesToStorage();
  }

  getDropdownProfile() {
    const id = parseInt(this.ui.profileDropdown.dataset.val.substring(1));
    return this.profiles.find((profile) => profile.id === id);
  }
  setupUI() {
    DOMElements.audioConfigContainer.addEventListener('click', (e) => {
      e.stopPropagation();
    });

    DOMElements.audioConfigContainer.addEventListener('keydown', (e) => {
      e.stopPropagation();
    });

    DOMElements.audioConfigContainer.addEventListener('keyup', (e) => {
      e.stopPropagation();
    });

    DOMElements.playerContainer.addEventListener('click', (e) => {
      this.closeUI();
    });

    DOMElements.audioConfigBtn.addEventListener('click', (e) => {
      if (DOMElements.audioConfigContainer.style.display === 'none') {
        this.openUI();
      } else {
        this.closeUI();
      }
      e.stopPropagation();
    });
    WebUtils.setupTabIndex(DOMElements.audioConfigBtn);

    const closeBtn = DOMElements.audioConfigContainer.getElementsByClassName('close_button')[0];
    closeBtn.addEventListener('click', (e) => {
      this.closeUI();
    });
    WebUtils.setupTabIndex(closeBtn);


    // setup dropdowns
    this.ui.profileManager = WebUtils.create('div', null, 'profile_manager');
    DOMElements.audioConfigContainer.appendChild(this.ui.profileManager);

    this.ui.profileDropdown = document.createElement('div');
    this.ui.profileManager.appendChild(this.ui.profileDropdown);
    this.updateProfileDropdown();

    // load button
    this.ui.loadButton = WebUtils.create('div', null, 'textbutton load_button');
    this.ui.loadButton.textContent = 'Load Profile';
    this.ui.profileManager.appendChild(this.ui.loadButton);
    this.ui.loadButton.addEventListener('click', () => {
      const profile = this.getDropdownProfile();
      if (!profile) {
        this.updateProfileDropdown();
        return;
      }
      this.setCurrentProfile(profile);
      this.refreshEQNodes();
    });
    WebUtils.setupTabIndex(this.ui.loadButton);

    // save button
    this.ui.saveButton = WebUtils.create('div', null, 'textbutton save_button');
    this.ui.saveButton.textContent = 'Save Profile';
    this.ui.profileManager.appendChild(this.ui.saveButton);
    this.ui.saveButton.addEventListener('click', () => {
      this.saveCurrentProfile();
    });
    WebUtils.setupTabIndex(this.ui.saveButton);

    // download button
    this.ui.downloadButton = WebUtils.create('div', 'margin-left: 5px', 'textbutton download_button');
    this.ui.downloadButton.textContent = 'Download Profile';
    this.ui.profileManager.appendChild(this.ui.downloadButton);
    this.ui.downloadButton.addEventListener('click', () => {
      const profile = this.getDropdownProfile();
      if (!profile) {
        this.updateProfileDropdown();
        return;
      }

      const data = {
        type: 'audioProfile',
        version: 1,
        profiles: [],
      };

      const profileObj = profile.toObj();
      delete profileObj.id;
      data.profiles.push(profileObj);

      const downloadBlob = new Blob([JSON.stringify(data, null, 2)], {type: 'application/json'});
      const a = document.createElement('a');
      a.href = URL.createObjectURL(downloadBlob);
      a.download = `${profile.label}.fsprofile.json`;
      a.click();
    });
    WebUtils.setupTabIndex(this.ui.saveButton);

    // delete button
    this.ui.deleteButton = WebUtils.create('div', null, 'textbutton delete_button');
    this.ui.deleteButton.textContent = 'Delete';
    this.ui.profileManager.appendChild(this.ui.deleteButton);
    this.ui.deleteButton.addEventListener('click', () => {
      const profile = this.getDropdownProfile();
      if (!profile) {
        this.updateProfileDropdown();
        return;
      }
      this.deleteProfile(profile);
    });
    WebUtils.setupTabIndex(this.ui.deleteButton);


    this.ui.dynamicsContainer = WebUtils.create('div', null, 'dynamics_container');
    DOMElements.audioConfigContainer.appendChild(this.ui.dynamicsContainer);

    this.ui.equalizer = WebUtils.create('div', null, 'equalizer');
    this.ui.dynamicsContainer.appendChild(this.ui.equalizer);

    const equalizerTitle = WebUtils.create('div', null, 'equalizer_title');
    equalizerTitle.textContent = 'Audio Equalizer';
    this.ui.equalizer.appendChild(equalizerTitle);

    this.ui.equalizerText = WebUtils.create('div', null, 'dynamics_center_text');
    this.ui.equalizerText.textContent = 'No audio context!';
    this.ui.equalizer.appendChild(this.ui.equalizerText);

    this.ui.spectrumCanvas = WebUtils.create('canvas', null, 'spectrum_canvas');
    this.ui.equalizer.appendChild(this.ui.spectrumCanvas);
    this.spectrumCtx = this.ui.spectrumCanvas.getContext('2d');

    this.ui.equalizerCanvas = WebUtils.create('canvas', null, 'equalizer_canvas');
    this.ui.equalizer.appendChild(this.ui.equalizerCanvas);
    this.equalizerCtx = this.ui.equalizerCanvas.getContext('2d');

    this.ui.equalizerFrequencyAxis = WebUtils.create('div', null, 'equalizer_frequency_axis');
    this.ui.equalizer.appendChild(this.ui.equalizerFrequencyAxis);

    this.ui.equalizerDecibelAxis = WebUtils.create('div', null, 'equalizer_decibel_axis');
    this.ui.equalizer.appendChild(this.ui.equalizerDecibelAxis);

    this.ui.equalizerNodes = WebUtils.create('div', null, 'equalizer_nodes');
    this.ui.equalizer.appendChild(this.ui.equalizerNodes);

    this.ui.zeroLineNode = WebUtils.create('div', null, 'zero_line_node');
    this.ui.equalizerNodes.appendChild(this.ui.zeroLineNode);
    this.ui.zeroLineNode.style.display = 'none';

    const moveZeroLineNode = (e) => {
      const pos = e.clientX - this.ui.equalizerNodes.getBoundingClientRect().left;
      let x = Utils.clamp(pos / this.ui.equalizerNodes.clientWidth * 100, 0, 100);
      if (x < 1) x = 0;
      else if (x > 99) x = 100;
      this.ui.zeroLineNode.style.left = `${x}%`;

      if (x === 0) {
        this.ui.zeroLineNode.classList.add('highpass');
      } else if (x === 100) {
        this.ui.zeroLineNode.classList.add('lowpass');
      } else {
        this.ui.zeroLineNode.classList.remove('highpass');
        this.ui.zeroLineNode.classList.remove('lowpass');
      }
    };

    this.ui.zeroLineNode.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!this.preAnalyser) return;

      let type = 'peaking';
      if (this.ui.zeroLineNode.classList.contains('highpass')) {
        type = 'highpass';
      } else if (this.ui.zeroLineNode.classList.contains('lowpass')) {
        type = 'lowpass';
      }
      const frequency = this.ratioToFrequency(parseFloat(this.ui.zeroLineNode.style.left) / 100);
      const node = new AudioEQNode(type, frequency, 0, 1);
      this.addEQNode(node);
    });

    const zeroLineNodeShowHide = (e)=> {
      // if no analysers, don't show the zero line node
      if (!this.preAnalyser || !this.postAnalyser) {
        this.ui.zeroLineNode.style.display = 'none';
        return;
      }

      // if targetting a node, don't show the zero line node
      if (e.target.classList.contains('equalizer_node')) {
        this.ui.zeroLineNode.style.display = 'none';
        return;
      }

      // if not close to halfway vertically, don't show the zero line node
      const y = e.clientY - this.ui.equalizer.getBoundingClientRect().top;
      if (y < this.ui.equalizer.clientHeight * 0.4 || y > this.ui.equalizer.clientHeight * 0.6) {
        this.ui.zeroLineNode.style.display = 'none';
        return;
      }

      this.ui.zeroLineNode.style.display = '';
      moveZeroLineNode(e);
    };
    this.ui.equalizer.addEventListener('mouseover', (e) => {
      zeroLineNodeShowHide(e);
    });

    this.ui.equalizer.addEventListener('mousemove', (e) => {
      zeroLineNodeShowHide(e);
      moveZeroLineNode(e);
    });


    this.ui.equalizer.addEventListener('mouseout', (e) => {
      this.ui.zeroLineNode.style.display = 'none';
      zeroLineNodeShowHide(e);
    });


    this.ui.compressor = WebUtils.create('div', null, 'compressor');
    this.ui.dynamicsContainer.appendChild(this.ui.compressor);

    this.ui.compressorTitle = WebUtils.create('div', null, 'compressor_title');
    this.ui.compressorTitle.textContent = 'Audio Compressor';
    this.ui.compressor.appendChild(this.ui.compressorTitle);

    this.ui.compressorText = WebUtils.create('div', null, 'dynamics_center_text');
    this.ui.compressorText.textContent = 'Audio compressor coming soon!';
    this.ui.compressor.appendChild(this.ui.compressorText);


    this.ui.mixer = WebUtils.create('div', null, 'mixer');
    this.ui.dynamicsContainer.appendChild(this.ui.mixer);

    this.ui.mixerTitle = WebUtils.create('div', null, 'mixer_title');
    this.ui.mixerTitle.textContent = 'Audio Channel Mixer';
    this.ui.mixer.appendChild(this.ui.mixerTitle);

    this.ui.mixerText = WebUtils.create('div', null, 'dynamics_center_text');
    this.ui.mixerText.textContent = 'Audio mixer coming soon!';
    this.ui.mixer.appendChild(this.ui.mixerText);


    this.ui.mixerContainer = WebUtils.create('div', null, 'mixer_container');
    this.ui.mixer.appendChild(this.ui.mixerContainer);

    this.ui.channels = WebUtils.create('div', null, 'channels');
    this.ui.mixerContainer.appendChild(this.ui.channels);

    this.ui.master = WebUtils.create('div', null, 'master');
    this.ui.mixerContainer.appendChild(this.ui.master);
  }

  addEQNode(node) {
    this.currentProfile.equalizerNodes.push(node);
    this.refreshEQNodes();
  }

  refreshEQNodes() {
    if (!this.currentProfile) return;
    try {
      this.preAnalyser.disconnect(this.postAnalyser);
    } catch (e) {

    }

    this.equalizerNodes.forEach((node) => {
      node.disconnect();
    });

    this.equalizerNodes = [];
    this.currentProfile.equalizerNodes.forEach((node) => {
      const eqNode = this.audioContext.createBiquadFilter();
      eqNode.type = node.type;
      eqNode.frequency.value = node.frequency;
      eqNode.gain.value = node.gain;
      eqNode.Q.value = node.q;

      this.equalizerNodes.push(eqNode);
    });

    this.equalizerNodes.forEach((node, index) => {
      if (index === 0) {
        this.preAnalyser.connect(node);
      } else {
        this.equalizerNodes[index - 1].connect(node);
      }
    });

    if (this.equalizerNodes.length === 0) {
      this.preAnalyser.connect(this.postAnalyser);
    } else {
      this.equalizerNodes[this.equalizerNodes.length - 1].connect(this.postAnalyser);
    }

    this.renderEqualizerResponse();
    this.updateEqualizerNodeMarkers();
  }
  ratioToFrequency(ratio) {
    const sampleRate = this.preAnalyser.context.sampleRate;
    const maxFreq = sampleRate / 2;
    const frequencyWidth = maxFreq;
    const logFrequencyWidth = Math.log10(frequencyWidth / 20);
    return Utils.clamp(Math.pow(10, ratio * logFrequencyWidth + Math.log10(20)), 0, maxFreq);
  }

  renderLoop() {
    if (!this.shouldRunRenderLoop) {
      this.renderLoopRunning = false;
      return;
    } else {
      requestAnimationFrame(() => {
        this.renderLoop();
      });
    }

    if (this.ui.equalizer.clientWidth !== this.pastWidth) {
      this.pastWidth = this.ui.equalizer.clientWidth;

      // Rerender equalizer response when width changes
      this.renderEqualizerResponse();
    }

    this.renderEqualizerSpectrum();
    this.renderMixerMeters();
  }

  startRenderLoop() {
    if (this.renderLoopRunning) return;
    this.shouldRunRenderLoop = true;
    this.renderLoopRunning = true;
    this.renderLoop();
  }

  stopRenderLoop() {
    this.shouldRunRenderLoop = false;
  }

  renderEqualizerSpectrum() {
    if (!this.preAnalyser || !this.postAnalyser) return;


    if (this.ui.equalizer.clientWidth === 0 || this.ui.equalizer.clientHeight === 0) return;

    const bufferLength = this.preAnalyser.frequencyBinCount;
    const dataArrayPre = new Uint8Array(bufferLength);
    const dataArrayPost = new Uint8Array(bufferLength);
    this.preAnalyser.getByteFrequencyData(dataArrayPre);
    this.postAnalyser.getByteFrequencyData(dataArrayPost);

    this.ui.spectrumCanvas.width = this.ui.equalizer.clientWidth * window.devicePixelRatio;
    this.ui.spectrumCanvas.height = this.ui.equalizer.clientHeight * window.devicePixelRatio;

    const width = this.ui.spectrumCanvas.width;
    const height = this.ui.spectrumCanvas.height;

    this.spectrumCtx.clearRect(0, 0, width, height);

    const sampleRate = this.preAnalyser.context.sampleRate;
    const maxFreq = sampleRate / 2;

    const frequencyWidth = maxFreq;
    const logFrequencyWidth = Math.log10(frequencyWidth) - Math.log10(20);

    // Draw bars but with log frequency scale
    const xScale = width / logFrequencyWidth;
    const yScale = height / 255;

    let lastX = -1;
    for (let i = 0; i < bufferLength; i++) {
      const x = Math.log10((i+1) * frequencyWidth / bufferLength, 1) - Math.log10(20);
      const x2 = Math.log10((i+2) * frequencyWidth / bufferLength, 1) - Math.log10(20);
      if (x < 0) continue;
      const yPre = dataArrayPre[i];
      const yPost = dataArrayPost[i];
      // sky blue->red colors based on strength
      const newX = Math.floor(x * xScale);
      if (newX === lastX) continue;

      const barWidth = Utils.clamp((x2 - x) * xScale / 2, 1, 5);
      // pre bar is gray
      if (yPost <= yPre) {
        this.spectrumCtx.fillStyle = `rgb(0, 50, 255)`;
        this.spectrumCtx.fillRect(newX, height - yPre * yScale, barWidth, yPre * yScale);
        this.spectrumCtx.fillStyle = `rgb(${yPost}, ${255 - yPost}, 255)`;
        this.spectrumCtx.fillRect(newX, height - yPost * yScale, barWidth, yPost * yScale);
        this.spectrumCtx.fillStyle = `rgba(0, 100, 180, 0.5)`;
        this.spectrumCtx.fillRect(newX, height - yPost * yScale, barWidth, yPost * yScale);
      } else {
        this.spectrumCtx.fillStyle = `rgb(${yPost}, ${255 - yPost}, 255)`;
        this.spectrumCtx.fillRect(newX, height - yPost * yScale, barWidth, yPost * yScale);
        this.spectrumCtx.fillStyle = `rgba(0, 100, 180, 0.5)`;
        this.spectrumCtx.fillRect(newX, height - yPre * yScale, barWidth, yPre * yScale);
      }
      lastX = newX;
    }
  }

  updateEqualizerNodeMarkers() {
    if (!this.preAnalyser) return;

    Array.from(this.ui.equalizerNodes.children).forEach((node) => {
      if (node.classList.contains('zero_line_node')) return;
      node.remove();
    });


    const typesThatUseGain = ['peaking', 'lowshelf', 'highshelf'];
    const typesThatUseQ = ['lowpass', 'highpass', 'bandpass', 'peaking', 'notch'];

    function nodeToString(node) {
      let str = `${StringUtils.formatFrequency(node.frequency.value)}Hz ${node.type}`;


      if (typesThatUseGain.includes(node.type)) {
        str += ` ${node.gain.value.toFixed(1)}dB`;
      }

      if (typesThatUseQ.includes(node.type)) {
        str += ` Q=${node.Q.value.toFixed(3)}`;
      }

      return str;
    }

    const sampleRate = this.preAnalyser.context.sampleRate;
    const maxFreq = sampleRate / 2;
    this.equalizerNodes.forEach((node, i) => {
      const el = WebUtils.create('div', null, 'equalizer_node tooltip');
      const frequencyPercent = Math.log10(node.frequency.value / 20) / Math.log10(maxFreq / 20);
      const gainDb = Utils.clamp(node.gain.value, -20, 20) / 40;

      const tooltipText = WebUtils.create('div', null, 'tooltiptext');
      tooltipText.textContent = nodeToString(node);
      el.appendChild(tooltipText);

      el.style.left = `${frequencyPercent * 100}%`;
      el.style.top = `${(-gainDb + 0.5) * 100}%`;
      WebUtils.setupTabIndex(el);
      this.ui.equalizerNodes.appendChild(el);

      let isDragging = false;

      const mouseMove = (e) => {
        if (!isDragging) return;
        const x = e.clientX - this.ui.equalizerNodes.getBoundingClientRect().left;
        const y = e.clientY - this.ui.equalizerNodes.getBoundingClientRect().top;

        const newXPercent = Utils.clamp(x / this.ui.equalizerNodes.clientWidth * 100, 0, 100);
        const newYPercent = Utils.clamp(y / this.ui.equalizerNodes.clientHeight * 100, 0, 100);


        const frequency = this.ratioToFrequency(newXPercent / 100);
        const newDB = Utils.clamp(-newYPercent + 50, -50, 50) / 100 * 40;


        el.style.left = `${newXPercent}%`;
        node.frequency.value = frequency;
        this.currentProfile.equalizerNodes[i].frequency = frequency;

        if (typesThatUseGain.includes(node.type)) {
          el.style.top = `${newYPercent}%`;
          node.gain.value = newDB;
          this.currentProfile.equalizerNodes[i].gain = newDB;
        } else {
          el.style.top = '50%';
        }
        tooltipText.textContent = nodeToString(node);
        this.renderEqualizerResponse();
      };

      const mouseUp = (e) => {
        isDragging = false;

        document.removeEventListener('mousemove', mouseMove);
        document.removeEventListener('mouseup', mouseUp);
      };

      el.addEventListener('mousedown', (e) => {
        if (isDragging) return;
        isDragging = true;
        e.stopPropagation();
        document.addEventListener('mousemove', mouseMove);
        document.addEventListener('mouseup', mouseUp);
      });

      el.addEventListener('wheel', (e) => {
        // scroll for q
        e.preventDefault();
        const delta = Math.sign(e.deltaY);
        const q = Utils.clamp(node.Q.value * Math.pow(1.1, delta), 0.0001, 1000);
        node.Q.value = q;
        this.currentProfile.equalizerNodes[i].q = q;
        tooltipText.textContent = nodeToString(node);
        this.renderEqualizerResponse();
      });

      let lastClick = 0;
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const now = Date.now();
        if (now - lastClick > 300) {
          lastClick = now;
          return;
        }
        lastClick = now;
        const rotateTypes = ['peaking', 'lowshelf', 'highshelf', 'lowpass', 'highpass', 'notch', 'bandpass'];
        const index = rotateTypes.indexOf(node.type);
        if (index === -1) return;

        const newType = rotateTypes[(index + 1) % rotateTypes.length];
        node.type = newType;
        this.currentProfile.equalizerNodes[i].type = newType;

        if (!typesThatUseGain.includes(node.type)) {
          el.style.top = '50%';
        } else {
          const gainDb = Utils.clamp(node.gain.value, -20, 20) / 40;
          el.style.top = `${(-gainDb + 0.5) * 100}%`;
        }
        tooltipText.textContent = nodeToString(node);
        this.renderEqualizerResponse();
      });

      el.addEventListener('contextmenu', (e) => {
        e.stopPropagation();
        e.preventDefault();
        const now = Date.now();
        if (now - lastClick > 300) {
          lastClick = now;
          return;
        }
        lastClick = now;
        const rotateTypes = ['peaking', 'lowshelf', 'highshelf', 'lowpass', 'highpass', 'notch', 'bandpass'];
        const index = rotateTypes.indexOf(node.type);
        if (index === -1) return;

        const newType = rotateTypes[(index - 1 + rotateTypes.length) % rotateTypes.length];
        node.type = newType;
        this.currentProfile.equalizerNodes[i].type = newType;

        if (!typesThatUseGain.includes(node.type)) {
          el.style.top = '50%';
        } else {
          const gainDb = Utils.clamp(node.gain.value, -20, 20) / 40;
          el.style.top = `${(-gainDb + 0.5) * 100}%`;
        }
        tooltipText.textContent = nodeToString(node);
        this.renderEqualizerResponse();
      });

      el.addEventListener('keydown', (e)=>{
        if (e.key === 'Delete' || e.key === 'Backspace') {
          this.currentProfile.equalizerNodes.splice(i, 1);
          this.refreshEQNodes();
        }
      });

      el.addEventListener('mouseenter', (e) => {
        el.focus();
      });

      el.addEventListener('mouseleave', (e) => {
        el.blur();
      });
    });
  }
  renderEqualizerResponse() {
    if (!this.preAnalyser || !this.postAnalyser) return;

    if (this.ui.equalizer.clientWidth === 0 || this.ui.equalizer.clientHeight === 0) return;

    this.ui.equalizerCanvas.width = this.ui.equalizer.clientWidth * window.devicePixelRatio;
    this.ui.equalizerCanvas.height = this.ui.equalizer.clientHeight * window.devicePixelRatio;

    const width = this.ui.equalizerCanvas.width;
    const height = this.ui.equalizerCanvas.height;
    const sampleRate = this.preAnalyser.context.sampleRate;
    const maxFreq = sampleRate / 2;

    const bufferLength = width;
    const frequencyArray = new Float32Array(bufferLength);
    const step = Math.log10(maxFreq / 20) / bufferLength;
    for (let i = 0; i < bufferLength; i++) {
      frequencyArray[i] = Math.min(Math.pow(10, i * step + Math.log10(20)), maxFreq);
    }

    const dbResponse = new Float32Array(bufferLength);

    const currentMagResponse = new Float32Array(bufferLength);
    const currentPhaseResponse = new Float32Array(bufferLength);

    this.equalizerNodes.forEach((node) => {
      node.getFrequencyResponse(frequencyArray, currentMagResponse, currentPhaseResponse);

      for (let i = 0; i < bufferLength; i++) {
        dbResponse[i] += 20 * Math.log10(currentMagResponse[i]);
      }
    });

    this.equalizerDbResponse = dbResponse;

    // draw lines
    this.equalizerCtx.clearRect(0, 0, width, height);

    const xScale = width / Math.log10(maxFreq / 20);
    const yScale = height / 40;

    this.equalizerCtx.beginPath();
    this.equalizerCtx.strokeStyle = 'green';
    this.equalizerCtx.lineWidth = 2;
    for (let i = 0; i < bufferLength; i++) {
      const x = Math.log10(frequencyArray[i] / 20);
      const y = dbResponse[i];
      if (i === 0) {
        this.equalizerCtx.moveTo(x * xScale, height / 2 - y * yScale);
      } else {
        this.equalizerCtx.lineTo(x * xScale, height / 2 - y * yScale);
      }
    }
    this.equalizerCtx.stroke();

    // fill in the area under the curve
    this.equalizerCtx.beginPath();
    this.equalizerCtx.fillStyle = 'rgba(0, 255, 0, 0.2)';
    this.equalizerCtx.moveTo(0, height / 2);

    for (let i = 0; i < bufferLength; i++) {
      const x = Math.log10(frequencyArray[i] / 20);
      const y = dbResponse[i];
      this.equalizerCtx.lineTo(x * xScale, height / 2 - y * yScale);
    }
    this.equalizerCtx.lineTo(width, height / 2);
    this.equalizerCtx.closePath();
    this.equalizerCtx.fill();
  }

  renderMixerMeters() {
    if (!this.currentProfile) return;

    const channels = this.currentProfile.mixerChannels;
    channels.forEach((channel) => {
      const analyzer = this.channelAnalyzers[channel.id];
      const els = this.mixerChannelElements[channel.id];

      if (!analyzer || !els) {
        return;
      }

      const canvas = els.volumeMeter;
      const ctx = els.volumeMeterCtx;

      const width = canvas.clientWidth * window.devicePixelRatio;
      const height = canvas.clientHeight * window.devicePixelRatio;
      if (width === 0 || height === 0) return;

      canvas.width = width;
      canvas.height = height;

      ctx.clearRect(0, 0, width, height);

      const volume = this.getVolume(analyzer);
      const yScale = height;

      const rectHeight = height / 50;
      const volHeight = volume * yScale;

      const rectCount = Math.ceil(volHeight / rectHeight);
      const now = Date.now();

      if (!els.peak || rectCount > els.peak) {
        els.peak = rectCount;
        els.peakTime = now;
      }

      for (let i = 0; i < rectCount; i++) {
        const y = height - i * rectHeight;


        ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
        ctx.fillRect(0, y, width, rectHeight);

        const color = `rgb(${Utils.clamp(i * 5, 0, 255)}, ${Utils.clamp(255 - i * 5, 0, 255)}, 0)`;
        ctx.fillStyle = color;
        ctx.fillRect(0, y + 1, width, rectHeight - 2);
      }

      const timeDiff = now - els.peakTime;

      // Code snippet from https://github.com/kevincennis/Mix.js/blob/master/src/js/views/app.views.track.js
      // MIT License
      /**
       * The MIT License (MIT)
       * Copyright (c) 2014 Kevin Ennis
       * https://github.com/kevincennis/Mix.js/blob/master/LICENSE
       */
      if ( timeDiff < 1000 && els.peak >= 1 ) {
        // for first 650 ms, use full alpha, then fade out
        const freshness = timeDiff < 650 ? 1 : 1 - ( ( timeDiff - 650 ) / 350 );
        ctx.fillStyle = 'rgba(238,119,85,' + freshness + ')';
        ctx.fillRect(0, height - els.peak * rectHeight - 1, width, 1);
      } else {
        els.peak = 0;
        els.peakTime = now;
      }
    });
  }

  setupEqualizerDecibelAxis() {
    this.ui.equalizerDecibelAxis.replaceChildren();
    const minDecibels = -20;
    const maxDecibels = 20;
    const decibelWidth = maxDecibels - minDecibels;

    for (let i = 0; i <= decibelWidth / 5; i++) {
      const db = Math.round(maxDecibels - i * 5);

      const el = WebUtils.create('div', null, 'eq_tick_marker');
      el.style.top = `${i / (decibelWidth / 5) * 100}%`;
      this.ui.equalizerDecibelAxis.appendChild(el);

      if (i % 2 === 0) {
        if (db === 0) {
          el.classList.add('zero_tick');
        } else {
          el.classList.add('major_tick');
        }
        const label = WebUtils.create('div', null, 'tick_label');
        label.textContent = `${db}`;
        el.appendChild(label);
      } else {
        el.classList.add('minor_tick');
      }
    }
  }
  setupEqualizerFrequencyAxis() {
    this.ui.equalizerFrequencyAxis.replaceChildren();

    const sampleRate = this.preAnalyser.context.sampleRate;
    const maxFreq = sampleRate / 2;
    const frequencyWidth = maxFreq;
    const logFrequencyWidth = Math.log10(frequencyWidth);
    const logFrequencyWidthUI = Math.log10(frequencyWidth / 20);

    for (let i = 0; i < Math.ceil(logFrequencyWidth); i++) {
      const frequency = Math.pow(10, i);
      const position = Math.log10(frequency / 20) / logFrequencyWidthUI;
      if (position >= 0) {
        const el = WebUtils.create('div', null, 'eq_tick_marker');
        el.style.left = `${position * 100}%`;
        this.ui.equalizerFrequencyAxis.appendChild(el);

        el.classList.add('major_tick');
        const label = WebUtils.create('div', null, 'tick_label');
        label.textContent = `${StringUtils.formatFrequency(frequency)}Hz`;
        el.appendChild(label);
      }

      for (let j = 1; j < 9; j++) {
        const subfrequency = frequency + j * frequency;
        const position = Math.log10(subfrequency / 20) / logFrequencyWidthUI;
        if (position < 0) continue;
        else if (position > 1) {
          break;
        }

        const el = WebUtils.create('div', null, 'eq_tick_marker');
        el.style.left = `${position * 100}%`;
        this.ui.equalizerFrequencyAxis.appendChild(el);
        el.classList.add('minor_tick');
        if (j === 4 || j === 1) {
          const label = WebUtils.create('div', null, 'tick_label');
          label.textContent = `${StringUtils.formatFrequency(subfrequency)}Hz`;
          el.appendChild(label);
        }
      }
    }

    let lastTick = this.ui.equalizerFrequencyAxis.lastChild;
    if (parseInt(lastTick.style.left) < 97) {
      const el = WebUtils.create('div', null, 'eq_tick_marker');
      this.ui.equalizerFrequencyAxis.appendChild(el);
      lastTick = el;
    }

    lastTick.style.left = '100%';
    lastTick.classList.add('major_tick');
    lastTick.classList.remove('minor_tick');

    if (!lastTick.lastChild) {
      const label = WebUtils.create('div', null, 'tick_label');
      label.textContent = `${maxFreq}Hz`;
      lastTick.appendChild(label);
    } else {
      lastTick.lastChild.textContent = `${StringUtils.formatFrequency(maxFreq)}Hz`;
    }
  }

  getVolume(analyser) {
    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    analyser.getByteFrequencyData(dataArray);

    let sum = 0;
    for (let i = 0; i < bufferLength; i++) {
      sum += dataArray[i];
    }
    return sum / bufferLength / 255;
  }

  dbToGain(db) {
    return Math.pow(10, db / 20);
  }

  gainToDB(gain) {
    return 20 * Math.log10(gain);
  }

  symmetricalLogScaleY(x, c) {
    return Math.sign(x) * (Math.log10(Math.abs(x / c) + 1));
  }

  symmetricalLogScaleX(y, c) {
    return Math.sign(y) * c * (Math.pow(10, Math.abs(y)) - 1);
  }

  mixerDBToPositionRatio(db) {
    if (db <= -50) {
      return 1;
    }

    const c = 40 / Math.log(10);
    const maxY = this.symmetricalLogScaleY(10, c);
    const minY = this.symmetricalLogScaleY(-50, c);
    const y = this.symmetricalLogScaleY(db, c);
    return Utils.clamp((maxY - y) / (maxY - minY), 0, 1);
  }

  mixerPositionRatioToDB(ratio) {
    if (ratio >= 1) {
      return -Infinity;
    }

    const c = 40 / Math.log(10);
    const maxY = this.symmetricalLogScaleY(10, c);
    const minY = this.symmetricalLogScaleY(-50, c);
    const y = maxY - ratio * (maxY - minY);
    return Utils.clamp(this.symmetricalLogScaleX(y, c), -50, 10);
  }

  setChannelGain(channel, gain) {
    channel.gain = gain;
    if (this.channelGains && this.channelGains[channel.id]) {
      this.channelGains[channel.id].gain.value = gain;
    }
  }

  createMixerElements() {
    const els = {};

    els.container = WebUtils.create('div', null, 'mixer_channel_container');

    els.channelTitle = WebUtils.create('div', null, 'mixer_channel_title');
    els.container.appendChild(els.channelTitle);

    els.buttons = WebUtils.create('div', null, 'mixer_channel_buttons');
    els.container.appendChild(els.buttons);

    els.soloButton = WebUtils.create('div', null, 'mixer_channel_solo');
    els.soloButton.textContent = 'S';
    els.soloButton.title = 'Solo';
    els.buttons.appendChild(els.soloButton);

    els.muteButton = WebUtils.create('div', null, 'mixer_channel_mute');
    els.muteButton.textContent = 'M';
    els.muteButton.title = 'Mute';
    els.buttons.appendChild(els.muteButton);

    els.volume = WebUtils.create('div', null, 'mixer_channel_volume');
    els.container.appendChild(els.volume);

    els.volumeAxis = WebUtils.create('div', null, 'mixer_channel_volume_axis');
    els.volume.appendChild(els.volumeAxis);

    // Volume axis goes from +10 to -60 then -inf
    for (let i = 0; i < 6; i++) {
      const db = 10 - i * 10;
      const el = WebUtils.create('div', null, 'mixer_channel_volume_tick');
      el.style.top = `${this.mixerDBToPositionRatio(db) * 100}%`;
      els.volumeAxis.appendChild(el);

      const label = WebUtils.create('div', null, 'mixer_channel_volume_tick_label');
      label.textContent = `${db > 0 ? '+' : ''}${db}`;
      el.appendChild(label);
    }

    const el = WebUtils.create('div', null, 'mixer_channel_volume_tick');
    el.style.top = `100%`;
    els.volumeAxis.appendChild(el);

    const label = WebUtils.create('div', null, 'mixer_channel_volume_tick_label');
    label.textContent = `-∞`;
    el.appendChild(label);


    els.volumeTrack = WebUtils.create('div', null, 'mixer_channel_volume_track');
    els.volume.appendChild(els.volumeTrack);

    els.volumeMeter = WebUtils.create('canvas', null, 'mixer_channel_volume_meter');
    els.volumeTrack.appendChild(els.volumeMeter);

    els.volumeMeterCtx = els.volumeMeter.getContext('2d');

    els.volumeHandle = WebUtils.create('div', null, 'mixer_channel_volume_handle');
    els.volumeTrack.appendChild(els.volumeHandle);

    return els;
  }

  createMixerChannel(channel) {
    const channelNames = ['Left', 'Right', 'Left Surround', 'Right Surround', 'Center', 'Bass (LFE)', 'Master'];
    const els = this.createMixerElements();
    els.channelTitle.textContent = channelNames[channel.id];

    els.volumeHandle.style.top = `${this.mixerDBToPositionRatio(this.gainToDB(channel.gain)) * 100}%`;

    if (channel.id === 6) { // master
      els.soloButton.style.display = 'none';
    }

    const currentProfile = this.currentProfile;
    const zeroPos = this.mixerDBToPositionRatio(0);
    const mouseMove = (e) => {
      const y = e.clientY - els.volumeTrack.getBoundingClientRect().top;
      let newYPercent = Utils.clamp(y / els.volumeTrack.clientHeight * 100, 0, 100);

      if (Math.abs(newYPercent / 100 - zeroPos) < 0.025) {
        newYPercent = zeroPos * 100;
      }

      if (newYPercent >= 98) {
        newYPercent = 100;
      }

      const db = this.mixerPositionRatioToDB(newYPercent / 100);
      els.volumeHandle.style.top = `${newYPercent}%`;
      this.setChannelGain(channel, this.dbToGain(db));
    };

    const mouseUp = (e) => {
      document.removeEventListener('mousemove', mouseMove);
      document.removeEventListener('mouseup', mouseUp);
    };

    els.volumeHandle.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      document.addEventListener('mousemove', mouseMove);
      document.addEventListener('mouseup', mouseUp);
    });

    els.volumeTrack.addEventListener('click', (e) => {
      mouseMove(e);
    });

    // els.volume.addEventListener('wheel', (e) => {
    //   if (e.deltaX !== 0) return; // ignore horizontal scrolling (for trackpad)
    //   e.preventDefault();
    //   const delta = Math.sign(e.deltaY);
    //   const ratio = parseFloat(els.volumeHandle.style.top) / 100;
    //   const db = this.mixerPositionRatioToDB(ratio - delta * 0.05);
    //   els.volumeHandle.style.top = `${this.mixerDBToPositionRatio(db) * 100}%`;
    //   this.setChannelGain(channel, this.dbToGain(db));
    // });

    els.volumeHandle.addEventListener('keydown', (e) => {
      const ratio = parseFloat(els.volumeHandle.style.top) / 100;
      if (e.key === 'ArrowUp') {
        e.stopPropagation();
        e.preventDefault();
        const db = this.mixerPositionRatioToDB(ratio - 0.025);
        els.volumeHandle.style.top = `${this.mixerDBToPositionRatio(db) * 100}%`;
        this.setChannelGain(channel, this.dbToGain(db));
      } else if (e.key === 'ArrowDown') {
        e.stopPropagation();
        e.preventDefault();

        const db = this.mixerPositionRatioToDB(ratio + 0.025);
        els.volumeHandle.style.top = `${this.mixerDBToPositionRatio(db) * 100}%`;
        this.setChannelGain(channel, this.dbToGain(db));
      }
    });
    els.volumeHandle.tabIndex = 0;

    els.soloButton.addEventListener('click', (e) => {
      if (!channel.solo) {
        currentProfile.mixerChannels.forEach((channel) => {
          const els = this.mixerChannelElements[channel.id];
          channel.solo = false;
          els.soloButton.classList.remove('active');
        });
      }

      channel.solo = !channel.solo;
      els.soloButton.classList.toggle('active', channel.solo);
      this.updateMixerNodes();
    });

    els.muteButton.addEventListener('click', (e) => {
      channel.muted = !channel.muted;
      els.muteButton.classList.toggle('active', channel.mute);
      this.updateMixerNodes();
    });


    return els;
  }

  refreshMixer() {
    this.ui.mixerText.style.display = 'none';

    this.ui.master.replaceChildren();
    this.ui.channels.replaceChildren();
    this.mixerChannelElements = [];

    if (!this.currentProfile) return;
    const mixerChannels = this.currentProfile.mixerChannels;

    if (mixerChannels.length < 7) {
      // add channels
      for (let i = mixerChannels.length; i < 7; i++) {
        mixerChannels.push(new AudioChannelControl(i, 1, false, false));
      }
    }

    for (let i = 0; i < 6; i++) {
      const channel = mixerChannels[i];
      const els = this.createMixerChannel(channel);
      this.ui.channels.appendChild(els.container);
      this.mixerChannelElements.push(els);
    }

    const els = this.createMixerChannel(mixerChannels[6]);
    this.ui.master.appendChild(els.container);
    this.mixerChannelElements.push(els);

    this.updateMixerNodes();
  }

  updateMixerNodes() {
    if (!this.channelGains || !this.currentProfile) return;
    const channels = this.currentProfile.mixerChannels;

    const soloChannel = channels.find((channel) => channel.solo);

    channels.forEach((channel, i) => {
      if (soloChannel && channel !== soloChannel && channel.id !== 6) {
        this.channelGains[channel.id].gain.value = 0;
      } else {
        this.channelGains[channel.id].gain.value = channel.muted ? 0 : channel.gain;
      }
    });
  }
  setupNodes() {
    this.audioContext = this.client.audioContext;
    this.audioSource = this.client.audioSource;

    this.preAnalyser = this.audioContext.createAnalyser();
    this.postAnalyser = this.audioContext.createAnalyser();

    this.preAnalyser.smoothingTimeConstant = 0.6;
    this.postAnalyser.smoothingTimeConstant = 0.6;
    // this.analyser.minDecibels = -100;
    // this.analyser.maxDecibels = 0;
    if (this.audioSource) {
      this.audioSource.connect(this.preAnalyser);
    }

    this.preAnalyser.connect(this.postAnalyser);
    this.ui.equalizerText.style.display = 'none';

    this.setupEqualizerFrequencyAxis();
    this.setupEqualizerDecibelAxis();
    this.refreshEQNodes();

    this.channelSplitter = this.audioContext.createChannelSplitter();
    this.postAnalyser.connect(this.channelSplitter);

    this.channelMerger = this.audioContext.createChannelMerger();

    this.channelGains = [];
    this.channelAnalyzers = [];
    for (let i = 0; i < 6; i++) {
      const gain = this.audioContext.createGain();
      this.channelGains.push(gain);

      this.channelSplitter.connect(gain, i);

      const analyser = this.audioContext.createAnalyser();
      analyser.fftSize = 32;

      this.channelAnalyzers.push(analyser);

      gain.connect(analyser);

      analyser.connect(this.channelMerger, 0, i);
    }

    this.finalGain = this.audioContext.createGain();
    this.channelMerger.connect(this.finalGain);

    this.finalAnalyser = this.audioContext.createAnalyser();
    this.finalAnalyser.fftSize = 32;
    this.finalGain.connect(this.finalAnalyser);

    this.channelGains.push(this.finalGain);
    this.channelAnalyzers.push(this.finalAnalyser);

    this.refreshMixer();

    if (DOMElements.audioConfigContainer.style.display !== 'none') {
      this.startRenderLoop();
    }
  }

  getOutputNode() {
    return this.finalAnalyser;
  }
}