/**
 * 材料集封面配置（collections.cover 列的 JSON 契约）
 *
 * cover 列最初约定为「预设纹理 id 或装帧图路径」的单值；建卷弹窗引入
 * 四维封面配置（装帧质地 / 封面插画 / 卷脊印文 / 册序编排）后升级为
 * 单字段 JSON（零迁移承载全部维度，旧裸值仍可解析）。本模块是该 JSON
 * 的单一来源：预设常量 + 解析（宽进，渲染安全）+ 序列化（严出，落库
 * 安全），web 与 Expo 双端共用。
 */

/** 封面配置（cover 列 JSON 的反序列化形态；全字段可选） */
export interface CollectionCoverConfig {
  /** 装帧质地预设 id（COVER_TEXTURES 白名单内的 id） */
  texture?: string;
  /** 封面插画路径（相对 ~/.pinglc/media，形如 covers/<uuid>.<ext>） */
  image?: string;
  /** 卷脊印文（单个字符） */
  seal?: string;
  /** 册序编排（卷签文案） */
  volume?: string;
}

/** 装帧质地预设（id 稳定落库；label/sub 供选择器与书影脚注展示） */
export const COVER_TEXTURES = [
  { id: 'linen', label: '粗麻布纹', sub: '原色肌理 · 朴雅' },
  { id: 'xuan', label: '宣纸洒金', sub: '澄泥微光 · 古穆' },
  { id: 'indigo', label: '深黛靛蓝', sub: '经阁重彩 · 渊深' },
  { id: 'ochre', label: '赭石古籍', sub: '朱红印泥 · 沉着' },
] as const;

/** 装帧质地预设 id（字面量联合） */
export type CoverTextureId = (typeof COVER_TEXTURES)[number]['id'];

/** 卷脊印文候选字（预设两印；缺省取首字「研」；预设外的印文经 UI「+」自定，仍受单字清洗约束） */
export const COVER_SEAL_CHARS = ['研', '藏'] as const;

/**
 * 册序编排候选（卷壹~卷陆 + 别卷）
 * value：落 cover JSON volume 字段的卷签文案；
 * rank ：映射 collections.sortOrder 的建议值——册序即真排序
 * （卷壹=10 … 卷陆=60，别卷垫底=90；未编排的存量卷 sortOrder=0 排最前）
 */
export const COVER_VOLUMES = [
  { value: '卷壹', rank: 10 },
  { value: '卷贰', rank: 20 },
  { value: '卷叁', rank: 30 },
  { value: '卷肆', rank: 40 },
  { value: '卷伍', rank: 50 },
  { value: '卷陆', rank: 60 },
  { value: '别卷', rank: 90 },
] as const;

/** 册序卷签值（字面量联合） */
export type CoverVolumeValue = (typeof COVER_VOLUMES)[number]['value'];

/**
 * 册序卷签 → sortOrder 建议值
 * @param value 卷签文案（cover JSON volume 字段）
 * @returns 白名单内返回 rank，白名单外（含空）返回 null——调用方自行决定回落值
 */
export function coverVolumeRank(value: string): number | null {
  return COVER_VOLUMES.find((v) => v.value === value)?.rank ?? null;
}

/** 封面插画扩展名 ↔ MIME 对照表（上传白名单 / 路径校验 / 出图回放共用单源，
 *  调整格式只改这一处） */
export const COVER_IMAGE_EXT_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

/** 封面插画单图体积上限（字节；上传服务端闸与立卷弹窗前置校验共用单源） */
export const COVER_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

/** 封面插画库内路径白名单（covers/ 下一层；扩展名取自 MIME 对照表，防路径穿越与任意读） */
const COVER_IMAGE_RE = new RegExp(`^covers\\/[\\w-]+\\.(${Object.keys(COVER_IMAGE_EXT_MIME).join('|')})$`);

/**
 * 清洗字符串字段：仅收字符串，去首尾空白并限长（按码点计数：代理对字符
 * 如扩展 B 汉字/emoji 在 UTF-16 里占 2 码元，按 length 计会被误判超长）
 * @param v   原始值
 * @param max 最大长度（trim 后，单位=字符）
 */
function cleanString(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  const chars = Array.from(s);
  return chars.length >= 1 && chars.length <= max ? s : undefined;
}

/** 质地 id 是否在预设白名单内 */
function isTextureId(v: string): v is CoverTextureId {
  return COVER_TEXTURES.some((t) => t.id === v);
}

/**
 * 解析 cover 列原始值 → 封面配置（宽进：非法字段逐项丢弃，绝不抛错）
 *
 * 兼容两条旧契约：裸纹理 id 字符串（如 "linen"）视为仅设质地；
 * 裸插画路径字符串（如 "covers/x.png"）视为仅设插画。
 *
 * @param raw cover 列原始值（可空）
 * @returns 全字段非法或入参为空返回 null（调用方按「未配置封面」渲染）
 */
export function parseCollectionCover(raw: string | null | undefined): CollectionCoverConfig | null {
  if (!raw) return null;

  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    // 非 JSON：落回旧单值契约识别（裸纹理 id / 裸插画路径）
    obj = raw;
  }
  if (typeof obj === 'string') {
    // 旧单值契约：非 JSON 原文，或库里存了带引号的 JSON 字符串旧值（如
    // '"linen"'）——parse 成功但结果是原始字符串，同路按裸值识别
    if (isTextureId(obj)) return { texture: obj };
    if (COVER_IMAGE_RE.test(obj)) return { image: obj };
    return null;
  }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const o = obj as Record<string, unknown>;

  const out: CollectionCoverConfig = {};
  /* 质地与其余字段同口径清洗（先去空白再白名单，否则 " linen " 会被整项丢弃） */
  const texture = cleanString(o.texture, 20);
  if (texture && isTextureId(texture)) out.texture = texture;
  /* 插画路径与其余字段同口径清洗（先去空白再白名单，" covers/x.png " 不整项丢弃） */
  const image = cleanString(o.image, 200);
  if (image && COVER_IMAGE_RE.test(image)) out.image = image;
  const seal = cleanString(o.seal, 1);
  if (seal) out.seal = seal;
  /* 册序：白名单收窄；旧版带别称的卷签值（如「卷壹 · 启篇」）按前缀归一到
     新档（「卷壹」），归一不了的（如「卷拾 · 荟萃」，新档无此册序）丢弃 */
  const volumeRaw = cleanString(o.volume, 24);
  if (volumeRaw) {
    const vol =
      COVER_VOLUMES.find((v) => v.value === volumeRaw) ??
      COVER_VOLUMES.find((v) => volumeRaw.startsWith(v.value));
    if (vol) out.volume = vol.value;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * 序列化封面配置 → cover 列落库字符串（严出：非法字段静默丢弃）
 *
 * 键序固定（texture → image → seal → volume），相同配置产出字节一致的
 * 字符串，便于等值比较与缓存；全字段非法返回空串（调用方落库 null）。
 *
 * @param config 封面配置（可含多余/非法字段，一律清洗）
 */
export function serializeCollectionCover(config: CollectionCoverConfig): string {
  // 解析即校验：序列化复用同一套字段白名单，避免两处规则漂移
  const parsed = parseCollectionCover(JSON.stringify(config));
  if (!parsed) return '';
  const out: Record<string, string> = {};
  if (parsed.texture !== undefined) out.texture = parsed.texture;
  if (parsed.image !== undefined) out.image = parsed.image;
  if (parsed.seal !== undefined) out.seal = parsed.seal;
  if (parsed.volume !== undefined) out.volume = parsed.volume;
  return JSON.stringify(out);
}
