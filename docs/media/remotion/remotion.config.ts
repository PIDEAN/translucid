import { Config } from '@remotion/cli/config';

// Frames and their JSON timelines come from the capture step (`playwright test -c docs/media`), written to
// docs/media/.out (gitignored).
Config.setPublicDir('../.out');
Config.setVideoImageFormat('png');
