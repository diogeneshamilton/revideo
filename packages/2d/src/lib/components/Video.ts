import {
  BBox,
  DependencyContext,
  PlaybackState,
  SerializedVector2,
  SignalValue,
  SimpleSignal,
  viaProxy,
} from '@revideo/core';
import Hls from 'hls.js';
import {computed, initial, nodeName, signal} from '../decorators';
import {DesiredLength} from '../partials';
import {drawImage} from '../utils';
import {ImageCommunication} from '../utils/video/ffmpeg-client';
import {getFrame} from '../utils/video/mp4-parser-manager';
import {Media, MediaProps} from './Media';

export interface VideoProps extends MediaProps {
  /**
   * {@inheritDoc Video.alpha}
   */
  alpha?: SignalValue<number>;
  /**
   * {@inheritDoc Video.smoothing}
   */
  smoothing?: SignalValue<boolean>;
  /**
   * {@inheritDoc Video.decoder}
   */
  decoder?: SignalValue<'web' | 'ffmpeg' | 'slow' | null>;
}

@nodeName('Video')
export class Video extends Media {
  /**
   * The alpha value of this video.
   *
   * @remarks
   * Unlike opacity, the alpha value affects only the video itself, leaving the
   * fill, stroke, and children intact.
   */
  @initial(1)
  @signal()
  public declare readonly alpha: SimpleSignal<number, this>;

  /**
   * Whether the video should be smoothed.
   *
   * @remarks
   * When disabled, the video will be scaled using the nearest neighbor
   * interpolation with no smoothing. The resulting video will appear pixelated.
   *
   * @defaultValue true
   */
  @initial(true)
  @signal()
  public declare readonly smoothing: SimpleSignal<boolean, this>;

  /**
   * Which decoder to use during rendering. The `web` decoder is the fastest
   * but only supports MP4 files. The `ffmpeg` decoder is slower and more resource
   * intensive but supports more formats. The `slow` decoder is the slowest but
   * supports all formats.
   *
   * @defaultValue null
   */
  @initial(null)
  @signal()
  public declare readonly decoder: SimpleSignal<
    'web' | 'ffmpeg' | 'slow' | null,
    this
  >;

  private static readonly pool: Record<string, HTMLVideoElement> = {};

  private static readonly imageCommunication = !import.meta.hot
    ? null
    : new ImageCommunication();

  public constructor(props: VideoProps) {
    super(props);

    // If the file is not mp4, warn.
    if (!this.fullSource().endsWith('.mp4')) {
      console.warn(
        `WARNING: Video source is not an MP4 file. This may significantly slow down rendering: ${this.fullSource()}`,
      );
    }
  }

  protected override desiredSize(): SerializedVector2<DesiredLength> {
    const custom = super.desiredSize();
    if (custom.x === null && custom.y === null) {
      const image = this.video();
      return {
        x: image.videoWidth,
        y: image.videoHeight,
      };
    }

    return custom;
  }

  protected mediaElement(): HTMLVideoElement {
    return this.video();
  }

  protected seekedMedia(): HTMLVideoElement {
    return this.seekedVideo();
  }

  protected fastSeekedMedia(): HTMLVideoElement {
    return this.fastSeekedVideo();
  }

  @computed()
  private video(): HTMLVideoElement {
    const src = viaProxy(this.fullSource());
    const key = `${this.key}/${src}`;
    let video = Video.pool[key];
    if (!video) {
      video = document.createElement('video');
      video.crossOrigin = 'anonymous';

      if (src.endsWith('.m3u8')) {
        const hls = new Hls();
        hls.loadSource(src);
        hls.attachMedia(video);
      } else {
        video.src = src;
      }

      Video.pool[key] = video;
    }

    if (video.readyState < 2) {
      DependencyContext.collectPromise(
        new Promise<void>(resolve => {
          const onCanPlay = () => {
            resolve();
            video.removeEventListener('canplay', onCanPlay);
          };

          const onError = () => {
            const reason = this.getErrorReason(video.error?.code);
            console.log(`ERROR: Error loading video: ${src}, ${reason}`);
          };

          video.addEventListener('canplay', onCanPlay);
          video.addEventListener('error', onError);
        }),
      );
    }

    return video;
  }

  @computed()
  protected seekedVideo(): HTMLVideoElement {
    const video = this.video();
    const time = this.clampTime(this.time());

    video.playbackRate = this.playbackRate();

    if (!video.paused) {
      video.pause();
    }

    if (this.lastTime === time) {
      return video;
    }

    this.setCurrentTime(time);

    return video;
  }

  @computed()
  protected fastSeekedVideo(): HTMLVideoElement {
    const video = this.video();
    const time = this.clampTime(this.time());

    video.playbackRate = this.playbackRate();

    if (this.lastTime === time) {
      return video;
    }

    const playing =
      this.playing() && time < video.duration && video.playbackRate > 0;
    if (playing) {
      if (video.paused) {
        DependencyContext.collectPromise(video.play());
      }
    } else {
      if (!video.paused) {
        video.pause();
      }
    }

    if (Math.abs(video.currentTime - time) > 0.3) {
      this.setCurrentTime(time);
    } else if (!playing) {
      video.currentTime = time;
    }

    return video;
  }

  protected lastFrame: HTMLImageElement | null = null;

  protected async webcodecSeekedVideo(): Promise<CanvasImageSource> {
    const video = this.video();
    const time = this.clampTime(this.time());

    video.playbackRate = this.playbackRate();

    if (this.lastFrame && this.lastTime === time) {
      return this.lastFrame;
    }

    const fps = this.view().fps() / this.playbackRate();
    return getFrame(this.key, video.src, time, fps);
  }

  protected async ffmpegSeekedVideo(): Promise<HTMLImageElement> {
    const video = this.video();
    const time = this.clampTime(this.time());
    const duration = this.getDuration();

    video.playbackRate = this.playbackRate();

    if (this.lastFrame && this.lastTime === time) {
      return this.lastFrame;
    }

    const fps = this.view().fps() / this.playbackRate();

    if (!Video.imageCommunication) {
      throw new Error('ServerSeekedVideo can only be used with HMR.');
    }

    const frame = await Video.imageCommunication.getFrame(
      this.key,
      video.src,
      time,
      duration,
      fps,
    );
    this.lastFrame = frame;
    this.lastTime = time;

    return frame;
  }

  protected async seekFunction() {
    const playbackState = this.view().playbackState();

    // During playback
    if (
      playbackState === PlaybackState.Playing ||
      playbackState === PlaybackState.Presenting
    ) {
      return this.fastSeekedVideo();
    }

    if (playbackState === PlaybackState.Paused) {
      return this.seekedVideo();
    }

    // During rendering, if set explicitly
    if (this.decoder() === 'slow') {
      return this.seekedVideo();
    }

    if (this.decoder() === 'ffmpeg') {
      return this.ffmpegSeekedVideo();
    }

    if (this.decoder() === 'web') {
      return this.webcodecSeekedVideo();
    }

    // If not set explicitly, use file extension to determine decoder
    if (this.src().endsWith('.mp4')) {
      return this.webcodecSeekedVideo();
    }

    if (this.src().endsWith('.webm')) {
      return this.ffmpegSeekedVideo();
    }

    return this.seekedVideo();
  }

  protected override async draw(context: CanvasRenderingContext2D) {
    this.drawShape(context);
    const alpha = this.alpha();
    if (alpha > 0) {
      const video = await this.seekFunction();

      const box = BBox.fromSizeCentered(this.computedSize());
      context.save();
      context.clip(this.getPath());
      if (alpha < 1) {
        context.globalAlpha *= alpha;
      }
      context.imageSmoothingEnabled = this.smoothing();
      drawImage(context, video, box);
      context.restore();
    }

    if (this.clip()) {
      context.clip(this.getPath());
    }

    await this.drawChildren(context);
  }

  protected override applyFlex() {
    super.applyFlex();
    const video = this.video();
    this.element.style.aspectRatio = (
      this.ratio() ?? video.videoWidth / video.videoHeight
    ).toString();
  }
}
