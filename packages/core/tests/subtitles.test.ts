/**
 * 字幕解析/序列化金样本测试
 *
 * 覆盖：正常 SRT/VTT、CRLF 换行、BOM、缺失序号、畸形时间、双语导入启发式、
 * 时间码往返（parse → serialize → parse 结果一致）、双语/单语序列化。
 */
import { describe, expect, it } from 'vitest';
import { parseSrt, serializeSrt } from '../src/subtitles/srt';
import { parseVtt, serializeVtt } from '../src/subtitles/vtt';
import { parseTimestamp, formatTimestamp } from '../src/subtitles/time';

/** 标准 SRT 样本（LF 换行） */
const SRT_LF = `1
00:00:01,000 --> 00:00:03,500
Stay hungry, stay foolish.

2
00:00:04,200 --> 00:00:07,800
This is the second line.
`;

/** CRLF + BOM + 缺失序号 + 畸形块的脏样本 */
const SRT_DIRTY = `﻿1\r
00:00:01,000 --> 00:00:03,500\r
First block.\r
\r
00:00:04,000 --> 00:00:02,000\r
Broken block (end before start).\r
\r
00:00:05,000 --> 00:00:06,000\r
No index line block.\r
`;

describe('时间码工具', () => {
  it('解析 SRT 逗号毫秒格式', () => {
    expect(parseTimestamp('00:01:02,500')).toBe(62_500);
  });
  it('解析 VTT 点毫秒格式', () => {
    expect(parseTimestamp('00:01:02.500')).toBe(62_500);
  });
  it('解析短格式（省略小时）', () => {
    expect(parseTimestamp('01:02.5')).toBe(62_500);
  });
  it('非法输入返回 null', () => {
    expect(parseTimestamp('abc')).toBeNull();
    expect(parseTimestamp('99:99:99,999')).toBeNull();
  });
  it('格式化毫秒为时间串', () => {
    expect(formatTimestamp(62_500, ',')).toBe('00:01:02,500');
    expect(formatTimestamp(3_661_500, '.')).toBe('01:01:01.500');
  });
});

describe('SRT 解析', () => {
  it('正常解析并重编号 index', () => {
    const { cues, errors } = parseSrt(SRT_LF);
    expect(errors).toHaveLength(0);
    expect(cues).toHaveLength(2);
    expect(cues[0]).toMatchObject({ index: 0, startMs: 1000, endMs: 3500, textEn: 'Stay hungry, stay foolish.' });
    expect(cues[1]).toMatchObject({ index: 1, startMs: 4200, endMs: 7800 });
  });

  it('容忍 BOM/CRLF/缺失序号，剔除畸形块并报错', () => {
    const { cues, errors } = parseSrt(SRT_DIRTY);
    expect(cues).toHaveLength(2); // 第 1 块 + 无序号块
    expect(errors).toHaveLength(1); // end < start 的块
    expect(cues[0]!.textEn).toBe('First block.');
    expect(cues[1]!.textEn).toBe('No index line block.');
  });

  it('双语启发式：英文行+中文行拆分为 textEn/textZh', () => {
    const srt = `1
00:00:01,000 --> 00:00:02,000
Hello world.
你好，世界。
`;
    const { cues } = parseSrt(srt);
    expect(cues[0]!.textEn).toBe('Hello world.');
    expect(cues[0]!.textZh).toBe('你好，世界。');
  });

  it('英文两行不含中文时不误拆', () => {
    const srt = `1
00:00:01,000 --> 00:00:02,000
Hello
world
`;
    const { cues } = parseSrt(srt);
    expect(cues[0]!.textEn).toBe('Hello\nworld');
    expect(cues[0]!.textZh).toBeNull();
  });
});

describe('VTT 解析', () => {
  it('解析带头的 VTT（含 NOTE 块与 cue 设置）', () => {
    const vtt = `WEBVTT

NOTE 这是注释块

intro
00:00:01.000 --> 00:00:03.000 align:start
First VTT cue.
`;
    const { cues, errors } = parseVtt(vtt);
    expect(errors).toHaveLength(0);
    expect(cues).toHaveLength(1);
    expect(cues[0]).toMatchObject({ startMs: 1000, endMs: 3000, textEn: 'First VTT cue.' });
  });

  it('缺少 WEBVTT 头时报错', () => {
    const { cues, errors } = parseVtt('00:00:01.000 --> 00:00:02.000\nNo header.');
    expect(cues).toHaveLength(0);
    expect(errors).toHaveLength(1);
  });

  it('以 NOTE/STYLE/REGION 开头的 cue 标识符不被误删', () => {
    // 规范允许任意非 "-->" 标识符；裸前缀正则会把 NOTES/REGIONAL-intro 整块吞掉
    const vtt = `WEBVTT

NOTES
00:00:01.000 --> 00:00:02.000
Notes identifier cue.

REGIONAL-intro
00:00:03.000 --> 00:00:04.000
Regional identifier cue.
`;
    const { cues, errors } = parseVtt(vtt);
    expect(errors).toHaveLength(0);
    expect(cues).toHaveLength(2);
    expect(cues[0]!.textEn).toBe('Notes identifier cue.');
    expect(cues[1]!.textEn).toBe('Regional identifier cue.');
  });

  it('X-TIMESTAMP-MAP 头：按 MPEGTS 基准平移全部句段', () => {
    // HLS 字幕常见：MPEGTS:900000 = 90kHz × 10s 基准，全部句段整体 +10s
    const vtt = `WEBVTT
X-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:900000

00:00:01.000 --> 00:00:02.000
Offset cue.
`;
    const { cues, errors } = parseVtt(vtt);
    expect(errors).toHaveLength(0);
    expect(cues).toHaveLength(1);
    expect(cues[0]!.startMs).toBe(11_000);
    expect(cues[0]!.endMs).toBe(12_000);
  });

  it('X-TIMESTAMP-MAP 头格式非法时报错并按原时间解析', () => {
    const vtt = `WEBVTT
X-TIMESTAMP-MAP=BOGUS

00:00:01.000 --> 00:00:02.000
Cue.
`;
    const { cues, errors } = parseVtt(vtt);
    expect(errors).toHaveLength(1);
    expect(cues[0]!.startMs).toBe(1000);
  });

  it('正文里以 X-TIMESTAMP-MAP= 开头的文本行不被误当作偏移头', () => {
    // 头区匹配限定：字幕文本恰好以该前缀开头时既不删除也不影响时间轴
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:02.000
X-TIMESTAMP-MAP=LOCAL:00:00:05.000,MPEGTS:900000
A suspicious text line.
`;
    const { cues, errors } = parseVtt(vtt);
    expect(errors).toHaveLength(0);
    expect(cues).toHaveLength(1);
    expect(cues[0]!.startMs).toBe(1000); // 未被当作头平移
    expect(cues[0]!.textEn).toContain('X-TIMESTAMP-MAP=LOCAL'); // 文本行保留
  });

  it('多份 X-TIMESTAMP-MAP（HLS 分片拼接）报错而非静默错轴', () => {
    const vtt = `WEBVTT
X-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:900000

00:00:01.000 --> 00:00:02.000
First segment cue.

WEBVTT
X-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:1800000

00:00:03.000 --> 00:00:04.000
Second segment cue.
`;
    const { errors } = parseVtt(vtt);
    expect(errors.some((e) => e.includes('2 份 X-TIMESTAMP-MAP'))).toBe(true);
  });

  it('负偏移使句段整体落在 0 之前时丢弃并报错，跨 0 句段仅钳起点', () => {
    // MPEGTS 基准晚于 LOCAL（中流切片）→ 负偏移 -3.5s：
    // 第一条 [1s,2s] 整体 < 0 → 丢弃；第二条 [3s,4s] 平移后 [-0.5s,0.5s] → 起点钳 0
    const vtt = `WEBVTT
X-TIMESTAMP-MAP=LOCAL:00:00:03.500,MPEGTS:0

00:00:01.000 --> 00:00:02.000
Dropped cue.

00:00:03.000 --> 00:00:04.000
Crossing cue.
`;
    const { cues, errors } = parseVtt(vtt);
    expect(cues).toHaveLength(1);
    expect(cues[0]!.textEn).toBe('Crossing cue.');
    expect(cues[0]!.startMs).toBe(0);
    expect(cues[0]!.endMs).toBe(500);
    expect(errors.some((e) => e.includes('1 条句段整体落在 0 之前'))).toBe(true);
  });
});

describe('序列化与往返', () => {
  it('SRT parse → serialize → parse 时间与文本一致', () => {
    const first = parseSrt(SRT_LF);
    const text = serializeSrt(first.cues, 'en');
    const second = parseSrt(text);
    expect(second.cues.map((c) => [c.startMs, c.endMs, c.textEn])).toEqual(
      first.cues.map((c) => [c.startMs, c.endMs, c.textEn])
    );
  });

  it('VTT 往返一致', () => {
    const first = parseVtt(`WEBVTT\n\n00:00:01.000 --> 00:00:03.250\nRound trip.\n`);
    const text = serializeVtt(first.cues, 'en');
    const second = parseVtt(text);
    expect(second.cues[0]).toMatchObject({ startMs: 1000, endMs: 3250, textEn: 'Round trip.' });
  });

  it('双语序列化：英文行后跟中文行', () => {
    const cues = parseSrt(SRT_LF).cues.map((c) => ({ ...c, textZh: '保持饥饿，保持愚蠢。' }));
    const text = serializeSrt(cues, 'bilingual');
    expect(text).toContain('Stay hungry, stay foolish.\n保持饥饿，保持愚蠢。');
  });

  it('仅中文序列化', () => {
    const cues = parseSrt(SRT_LF).cues.map((c) => ({ ...c, textZh: '中文译文' }));
    const text = serializeSrt(cues, 'zh');
    expect(text).toContain('中文译文');
    expect(text).not.toContain('Stay hungry');
  });

  it('zh 序列化缺中文时回退英文（SRT/VTT 行为统一，不产出空块）', () => {
    // 半译状态（部分 cue textZh=null）：回退英文行，重新解析不丢句
    const cues = parseSrt(SRT_LF).cues;
    const srt = serializeSrt(cues, 'zh');
    const vtt = serializeVtt(cues, 'zh');
    expect(srt).toContain('Stay hungry');
    expect(vtt).toContain('Stay hungry');
    expect(parseSrt(srt).cues).toHaveLength(2);
    expect(parseVtt(vtt).cues).toHaveLength(2);
  });

  it('畸形块的错误信息按原始块号定位（不受跳过/成功块影响）', () => {
    const srt = `1
00:00:01,000 --> 00:00:00,000
Broken one.

2
00:00:01,000 --> 00:00:02,000
Good.

3
00:00:03,000 --> 00:00:02,000
Broken three.
`;
    const { errors } = parseSrt(srt);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain('第 1 块');
    expect(errors[1]).toContain('第 3 块');
  });
});
