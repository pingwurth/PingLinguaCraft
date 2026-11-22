/**
 * 结构化 LLM 生成单源（服务端）
 *
 * 「enginePost → zod 校验 → 失败带错误修复重试一次」的完整回路：jobs 管线
 * （测验/深学卡/辨析矩阵）与同步路由（仿写点拨）共用——此前仿写路由手抄
 * 一份内联循环，温度/重试次数/错误映射三处各改各的必然漂移。
 */

import type { z } from 'zod';
import { EngineError, enginePost } from '@/lib/server/engine';
import { resolveProfile, toEngineProfile, type ResolvedProfile } from '@/lib/server/providers';
import { repairPrompt } from '@/lib/quiz';

/** LLM 档案未配置（调用方可据此映射 400；其余 EngineError 一律网关类错误）——
 *  不能靠 status===0 判别：引擎不可达/生成不合规也用 0，混判会把网关故障
 *  伪装成客户端错误 */
export class LlmProfileMissingError extends EngineError {
  constructor(message: string) {
    super(message, 0);
  }
}

/**
 * 结构化生成：want_json 请求 + schema 校验 + 修复重试一次
 * @param opts.schema     产物 zod schema
 * @param opts.system     系统提示
 * @param opts.user       用户提示
 * @param opts.label      产物名（错误文案用，如「测验」「深学卡」「点拨」）
 * @param opts.onProgress 进度回调（stage 区分首 generation 与修复重试两段）
 * @returns 解析后的数据与生效档案（provider 落库溯源用）
 */
export async function structuredLLM<T>(opts: {
  schema: z.ZodType<T>;
  system: string;
  user: string;
  label: string;
  onProgress?: (stage: 'generate' | 'repair', message: string) => void;
}): Promise<{ data: T; profile: ResolvedProfile }> {
  const profile = resolveProfile('llm');
  if (!profile || profile.kind !== 'cloud') {
    throw new LlmProfileMissingError('未配置 LLM 档案（设置页添加 GLM/DeepSeek/GPT 等端点）');
  }

  // 进度文案复用调用方的领域 label（如「深学卡」），任务面板不丢上下文
  opts.onProgress?.('generate', `${opts.label}生成中（${profile.name}）…`);
  let r = await enginePost<{ json: unknown }>('/llm/chat', {
    profile: toEngineProfile(profile),
    system: opts.system,
    user: opts.user,
    want_json: true,
    temperature: 0.4,
  });
  let parsed = opts.schema.safeParse(r.json);

  // 修复重试一次（zod 校验失败 → 把错误回喂，修复提示词共用 quiz.ts 的 repairPrompt）
  if (!parsed.success) {
    opts.onProgress?.('repair', '结构校验未过，修复重试…');
    r = await enginePost<{ json: unknown }>('/llm/chat', {
      profile: toEngineProfile(profile),
      system: opts.system,
      user: `${opts.user}\n\n${repairPrompt(parsed.error.issues)}`,
      want_json: true,
      temperature: 0.2,
    });
    parsed = opts.schema.safeParse(r.json);
  }
  if (!parsed.success) {
    const detail = parsed.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('；');
    throw new EngineError(`模型两次都未产出合规${opts.label}：${detail}`, 0);
  }
  return { data: parsed.data, profile };
}
