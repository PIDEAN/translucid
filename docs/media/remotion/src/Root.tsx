import { Composition, staticFile } from 'remotion';
import { Promo, type PromoProps } from './Promo';
import { Scene, type SceneProps } from './Scene';
import { build, FPS, H, W, type SceneData } from './timeline';

/** One composition per README animation; ids match the capture scenes in ../features.media.ts. */
export const SCENES = [
  { id: 'languages', title: '站点语言包' },
  { id: 'scan', title: '一键本地化' },
  { id: 'review', title: '审核与生成' },
  { id: 'picker', title: '调整范围' },
  { id: 'immersive', title: '网页翻译' },
] as const;

export function Root() {
  return (
    <>
      {SCENES.map((s) => (
        <Composition
          key={s.id}
          id={s.id}
          component={Scene}
          width={W}
          height={H}
          fps={FPS}
          durationInFrames={FPS}
          defaultProps={{ scene: s.id, title: s.title, data: null } satisfies SceneProps}
          calculateMetadata={async ({ props }) => {
            const data = (await fetch(staticFile(`${props.scene}.json`)).then((r) => r.json())) as SceneData;
            return { durationInFrames: Math.ceil((build(data).total / 1000) * FPS), props: { ...props, data } };
          }}
        />
      ))}
      {/* Chrome Web Store promo tiles (stills; see store.mjs). */}
      <Composition id="promo-small" component={Promo} width={440} height={280} fps={FPS} durationInFrames={1} defaultProps={{ variant: 'small' } satisfies PromoProps} />
      <Composition id="promo-marquee" component={Promo} width={1400} height={560} fps={FPS} durationInFrames={1} defaultProps={{ variant: 'marquee' } satisfies PromoProps} />
    </>
  );
}
