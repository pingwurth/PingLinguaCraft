/**
 * 占位页共享骨架（M0 各未实现页面的统一「建设之中」呈现）
 *
 * 各占位页只提供标题与交付说明，避免多页各自复制同一份 JSX 后漂移。
 * 对应里程碑页面实现后，删除该页文件即可（本组件随之失去最后一个使用者时一并移除）。
 */

/** 占位页组件属性 */
interface PlaceholderPageProps {
  /** 页面标题（衬线大标题） */
  title: string;
  /** 占位卡片内的交付说明文案（如「此页面将在 M1 里程碑交付」） */
  note: string;
}

/**
 * 占位页组件：统一容器边距 + 页头 + 虚线占位卡片
 * @param props.title 页面标题
 * @param props.note  交付说明文案
 */
export function PlaceholderPage({ title, note }: PlaceholderPageProps) {
  return (
    /* 页面容器：与首页一致的外边距体系 */
    <div className="mx-auto w-full max-w-6xl px-5 py-6 md:px-12 md:py-10">
      {/* 页头 */}
      <header className="mb-6">
        <h2 className="font-serif text-2xl md:text-3xl">{title}</h2>
        <p className="mt-1 text-sm text-ochre">建设之中 · 敬请期待</p>
      </header>
      {/* 占位卡片：虚线边 + 纸卡底 */}
      <div className="rounded-md border border-dashed bg-card/50 px-6 py-16 text-center text-sm text-muted-foreground">
        {note}
      </div>
    </div>
  );
}
