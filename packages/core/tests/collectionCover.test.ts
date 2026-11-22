/**
 * 材料集封面配置契约测试：parseCollectionCover / serializeCollectionCover
 * （cover 列 JSON 的解析宽进与序列化严出分支必须锁死——双端渲染与 API 落库共用）
 */

import { describe, expect, it } from 'vitest';
import {
  COVER_TEXTURES,
  COVER_VOLUMES,
  coverVolumeRank,
  parseCollectionCover,
  serializeCollectionCover,
} from '../src/collections/cover';

describe('parseCollectionCover（宽进：非法字段逐项丢弃）', () => {
  it('空入参返回 null', () => {
    expect(parseCollectionCover(null)).toBeNull();
    expect(parseCollectionCover(undefined)).toBeNull();
    expect(parseCollectionCover('')).toBeNull();
  });

  it('完整 JSON 配置逐字段解析', () => {
    expect(
      parseCollectionCover('{"texture":"ochre","image":"covers/a-b.png","seal":"研","volume":"卷叁"}'),
    ).toEqual({ texture: 'ochre', image: 'covers/a-b.png', seal: '研', volume: '卷叁' });
  });

  it('部分字段：合法字段保留、非法字段丢弃', () => {
    expect(parseCollectionCover('{"texture":"未知纹理","seal":"研"}')).toEqual({ seal: '研' });
    expect(parseCollectionCover(`{"volume":"${'x'.repeat(30)}"}`)).toBeNull();
  });

  it('册序白名单：白名单外卷签丢弃；旧版带别称卷签按前缀归一', () => {
    expect(parseCollectionCover('{"volume":"卷柒"}')).toBeNull();
    expect(parseCollectionCover('{"volume":"卷壹 · 启篇"}')).toEqual({ volume: '卷壹' });
    expect(parseCollectionCover('{"volume":"卷拾 · 荟萃"}')).toBeNull();
  });

  it('插画路径白名单：拒绝路径穿越与受限扩展名', () => {
    expect(parseCollectionCover('{"image":"../etc/passwd.png"}')).toBeNull();
    expect(parseCollectionCover('{"image":"covers/x.svg"}')).toBeNull();
    expect(parseCollectionCover('{"image":"covers/sub/x.png"}')).toBeNull();
    expect(parseCollectionCover('{"image":"covers/a.webp"}')).toEqual({ image: 'covers/a.webp' });
  });

  it('旧契约兼容：裸纹理 id / 裸插画路径字符串', () => {
    expect(parseCollectionCover('linen')).toEqual({ texture: 'linen' });
    expect(parseCollectionCover('covers/legacy.jpg')).toEqual({ image: 'covers/legacy.jpg' });
  });

  it('非对象 JSON / 无法识别的裸字符串返回 null', () => {
    expect(parseCollectionCover('[1,2]')).toBeNull();
    expect(parseCollectionCover('42')).toBeNull();
    expect(parseCollectionCover('不是配置')).toBeNull();
    expect(parseCollectionCover('{"texture":"linen"}')).toEqual({ texture: 'linen' });
  });
});

describe('serializeCollectionCover（严出：清洗 + 固定键序）', () => {
  it('固定键序序列化（texture → image → seal → volume）', () => {
    expect(
      serializeCollectionCover({ volume: '卷贰', seal: '藏', texture: 'xuan', image: 'covers/k.webp' }),
    ).toBe('{"texture":"xuan","image":"covers/k.webp","seal":"藏","volume":"卷贰"}');
  });

  it('非法字段静默丢弃，空字段不产出键', () => {
    expect(serializeCollectionCover({ texture: 'nope' as never, seal: '研' })).toBe('{"seal":"研"}');
    expect(serializeCollectionCover({ image: 'covers/../x.png' })).toBe('');
  });

  it('多余字段被清洗掉（经解析白名单过滤）', () => {
    expect(
      serializeCollectionCover({ texture: 'linen', evil: 'x' } as unknown as Record<string, never>),
    ).toBe('{"texture":"linen"}');
  });

  it('全空/全非法返回空串（调用方落库 null）', () => {
    expect(serializeCollectionCover({})).toBe('');
  });

  it('往返一致：serialize → parse 幂等', () => {
    const config = { texture: COVER_TEXTURES[3]!.id, image: 'covers/r-1.jpg', seal: '悟', volume: '别卷' };
    expect(parseCollectionCover(serializeCollectionCover(config))).toEqual(config);
  });

  it('带引号的 JSON 字符串旧值回落旧单值契约', () => {
    expect(parseCollectionCover('"linen"')).toEqual({ texture: 'linen' });
    expect(parseCollectionCover('"covers/x.png"')).toEqual({ image: 'covers/x.png' });
    expect(parseCollectionCover('"乱写的"')).toBeNull();
  });

  it('texture/image 先去空白再白名单（" linen " 不整项丢弃）', () => {
    expect(parseCollectionCover('{"texture":" linen "}')).toEqual({ texture: 'linen' });
    expect(parseCollectionCover('{"image":" covers/x.png "}')).toEqual({ image: 'covers/x.png' });
  });

  it('字段限长按码点计（代理对单字不算超长）', () => {
    // U+2A6A5（扩展 B 汉字）UTF-16 占 2 码元：按码点计是 1 字，应被接受
    expect(parseCollectionCover('{"seal":"\ud869\udea5"}')).toEqual({ seal: '\ud869\udea5' });
  });
});

describe('coverVolumeRank（册序 → sortOrder 建议值）', () => {
  it('卷壹=10 … 卷陆=60，别卷垫底=90', () => {
    expect(coverVolumeRank('卷壹')).toBe(10);
    expect(coverVolumeRank('卷陆')).toBe(60);
    expect(coverVolumeRank('别卷')).toBe(90);
  });

  it('白名单外返回 null（调用方自行回落）', () => {
    expect(coverVolumeRank('卷柒')).toBeNull();
    expect(coverVolumeRank('')).toBeNull();
  });

  it('候选集与 rank 表一致（七档：卷壹~卷陆 + 别卷）', () => {
    expect(COVER_VOLUMES.map((v) => v.value)).toEqual(['卷壹', '卷贰', '卷叁', '卷肆', '卷伍', '卷陆', '别卷']);
  });
});
