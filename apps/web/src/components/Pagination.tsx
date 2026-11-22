'use client';

/**
 * 分页控件（纸墨风共享组件）
 *
 * 上一页/下一页 + 页码窗格：首页、末页与当前页 ±1 恒在，间隙收窄为省略号，
 * 总页数较少（≤ 7）时全量平铺。受控组件——页码由父层持有，本组件只上抛
 * 翻页意图；数据拉取与列表切片由调用方自理。单页（totalPages ≤ 1）返回
 * null 自动隐藏，调用方可恒渲染无需判空。样式走 surface-container 令牌族
 * （与藏经阁筛选药丸同源），无裸色值。
 */

/**
 * 页码窗格：生成页码序列（正常页码或省略号占位）
 *
 * 规则：总页数 ≤ 7 全量平铺；否则恒含首页、末页与当前页 ±1（越界候选
 * 剔除、去重后升序），序列断档（相邻页码差 > 1）以省略号占位。
 * @param page 当前页码（1 起）
 * @param totalPages 总页数（≥ 1）
 * @returns 页码窗格项（升序；'ellipsis' 为省略号占位）
 */
export function pageItems(page: number, totalPages: number): Array<number | 'ellipsis'> {
  /* 少页全量平铺：无需窗格收窄 */
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }
  /* 窗格候选：首尾恒在 + 当前页 ±1（Set 去重，越界剔除后升序） */
  const picks = [...new Set([1, totalPages, page - 1, page, page + 1])]
    .filter((p) => p >= 1 && p <= totalPages)
    .sort((a, b) => a - b);
  /* 断档补省略号：相邻候选页码差 > 1 即插入一枚 */
  const out: Array<number | 'ellipsis'> = [];
  let prev = 0;
  for (const p of picks) {
    if (prev > 0 && p - prev > 1) out.push('ellipsis');
    out.push(p);
    prev = p;
  }
  return out;
}

/**
 * 分页控件
 * @param props.page 当前页码（1 起；父层钳制后的有效值）
 * @param props.totalPages 总页数
 * @param props.onChange 翻页回调（传出目标页码；切片/拉取由父层负责）
 * @param props.label 无障碍导航名（同页多实例时可区分，如「集卷分页」）
 */
export function Pagination({
  page,
  totalPages,
  onChange,
  label,
}: {
  page: number;
  totalPages: number;
  onChange: (page: number) => void;
  label: string;
}) {
  /* 单页无翻页意义：整组不出（调用方可直接恒渲染） */
  if (totalPages <= 1) return null;

  /** 钳位翻页：目标页码收敛到 [1, totalPages] 再上抛，防越界页码外漏 */
  const go = (p: number) => onChange(Math.min(totalPages, Math.max(1, p)));

  /** 页码/翻页钮统一样式：选中段仿筛选药丸（container-highest 槽 + 浓墨字），未选弱化 */
  const btnCls = (active: boolean) =>
    `flex size-9 items-center justify-center rounded-xl text-title-sm transition-colors ${
      active
        ? 'bg-surface-container-highest font-medium text-on-surface'
        : 'text-on-surface-variant hover:bg-surface-container hover:text-on-surface'
    }`;

  return (
    /* 分页导航（无障碍名由 label 注入） */
    <nav aria-label={label} className="flex items-center gap-1">
      {/* 上一页钮：首页禁用 */}
      <button
        type="button"
        aria-label="上一页"
        disabled={page <= 1}
        onClick={() => go(page - 1)}
        className={`${btnCls(false)} disabled:pointer-events-none disabled:opacity-30`}
      >
        <span aria-hidden className="material-symbols-outlined text-lg">chevron_left</span>
      </button>
      {/* 页码窗格：省略号为纯展示占位，页码可点、当前页 aria-current 标注 */}
      {pageItems(page, totalPages).map((it, i) =>
        it === 'ellipsis' ? (
          <span
            key={`ellipsis-${i}`}
            aria-hidden
            className="flex size-9 items-center justify-center text-on-surface-variant"
          >
            …
          </span>
        ) : (
          <button
            key={it}
            type="button"
            aria-label={`第 ${it} 页`}
            aria-current={it === page ? 'page' : undefined}
            /* onChange 恒上抛（受控语义），页码未变的副作用收窄由调用方判断 */
            onClick={() => go(it)}
            className={btnCls(it === page)}
          >
            {it}
          </button>
        ),
      )}
      {/* 下一页钮：末页禁用 */}
      <button
        type="button"
        aria-label="下一页"
        disabled={page >= totalPages}
        onClick={() => go(page + 1)}
        className={`${btnCls(false)} disabled:pointer-events-none disabled:opacity-30`}
      >
        <span aria-hidden className="material-symbols-outlined text-lg">chevron_right</span>
      </button>
    </nav>
  );
}
