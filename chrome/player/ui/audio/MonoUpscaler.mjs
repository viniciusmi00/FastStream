import {AbstractAudioModule} from './AbstractAudioModule.mjs';

export class MonoUpscaler extends AbstractAudioModule {
  constructor() {
    super('MonoUpscaler');
    this.bypassed = true;
  }

  setupNodes(audioContext) {
    super.setupNodes(audioContext);
    this.getInputNode().connect(this.getOutputNode());

    if (!this.bypassed) {
      this.disable();
      this.enable();
    }
  }

  enable() {
    if (this.bypassed || !this.audioContext) {
      return;
    }

    this.splitter = this.audioContext.createChannelSplitter(6);
    this.merger = this.audioContext.createChannelMerger(6);

    for (let i = 2; i < 6; i++) {
      this.splitter.connect(this.merger, i, i);
    }

    this.stereoPanner = this.audioContext.createStereoPanner();
    this.stereoPanner.channelInterpretation = 'discrete';

    this.getInputNode().disconnect(this.getOutputNode());
    this.getInputNode().connect(this.splitter);
    this.getInputNode().connect(this.stereoPanner);
    this.getOutputNode().connectFrom(this.merger);

    this.bypassed = false;
  }

  disable() {
    if (!this.bypassed) {
      return;
    }

    this.getInputNode().disconnect(this.splitter);
    this.getInputNode().disconnect(this.stereoPanner);
    this.getOutputNode().disconnectFrom(this.merger);

    this.getInputNode().connect(this.getOutputNode());

    this.splitter.disconnect();
    this.merger.disconnect();
    this.stereoPanner.disconnect();

    this.splitter = null;
    this.merger = null;
    this.stereoPanner = null;

    this.bypassed = true;
  }
}
