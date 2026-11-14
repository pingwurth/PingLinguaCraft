/**
 * 首页 —— 藏经阁（材料集汇聚地，需求 19）
 *
 * M0 里程碑为占位实现：展示页面骨架与空态。
 * M1 里程碑将实现：材料集网格、统计（卷数/时长/句数）、继续学习书签、
 * 分页材料列表、导入入口（对应设计稿 _12 移动 / _10 桌面）。
 */
import Link from 'next/link';

/**
 * 首页组件：藏经阁占位
 */
export default function HomePage() {
  return (
    /* 页面容器：外边距遵循设计系统（移动 20px / 桌面 48px） */
    <div className="mx-auto w-full max-w-6xl px-5 py-6 md:px-12 md:py-10">
      {/* 页头：衬线大标题 + slogan */}
      <header className="mb-8">
        <h2 className="font-serif text-2xl md:text-3xl">藏经阁 · 聚纳百卷</h2>
        <p className="mt-1 text-sm text-ochre">书山万仞吾独取，不向旁人问径蹊</p>
      </header>

      {/* 统计条占位：卷数 / 音频总时长 / 句子数（M1 接入真实数据） */}
      <section className="mb-8 grid grid-cols-3 gap-3">
        {[
          { label: '卷帙', value: '—' },
          { label: '研习时长', value: '—' },
          { label: '句段', value: '—' },
        ].map((stat) => (
          /* 单个统计卡：纸卡底 + 书边细线 */
          <div key={stat.label} className="rounded-md border bg-card px-4 py-3 text-center">
            <p className="font-serif text-xl">{stat.value}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{stat.label}</p>
          </div>
        ))}
      </section>

      {/* 空态引导：尚无材料集时展示导入指引 */}
      <section className="flex flex-col items-center justify-center rounded-md border border-dashed bg-card/50 px-6 py-16 text-center">
        {/* 印章式图标 */}
        <span className="material-symbols-outlined mb-3 text-4xl text-ochre">library_books</span>
        <p className="font-serif text-lg">尚无卷帙，虚位以待</p>
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">
          导入音视频自动生成字幕，或导入文本自动生成音频，开始你的第一卷研习。
        </p>
        {/* 导入入口按钮：朱砂主色 */}
        <Link
          href="/import"
          className="mt-6 rounded-md bg-primary px-6 py-2.5 text-sm text-primary-foreground transition-colors hover:bg-primary-hover"
        >
          纳新入卷（导入材料）
        </Link>
      </section>
    </div>
  );
}
