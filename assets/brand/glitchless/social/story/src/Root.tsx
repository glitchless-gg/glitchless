import { Composition } from 'remotion';
import { Story, TOTAL_FRAMES } from './Video';
import { FPS } from './theme';

export const RemotionRoot = () => <Composition id="Story" component={Story} durationInFrames={TOTAL_FRAMES} fps={FPS} width={1920} height={1080} />;
