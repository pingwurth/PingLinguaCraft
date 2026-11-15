/**
 * App 入口：三屏导航（无导航库，state 切换保持骨架零依赖）
 * 设置屏（服务地址）→ 藏经阁（材料集）→ 集内材料 → 播放页（音频 + 双语跟随）
 */

import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { StatusBar as ExpoStatusBar } from 'expo-status-bar';
import { useAudioPlayer } from 'expo-audio';
import type { AudioStatus } from 'expo-audio';
import { findCueIndex } from '@pinglc/core';
import { api, getBaseUrl, setBaseUrl, type Collection, type CueDTO, type MaterialListItem } from './lib/api';

/** 纸墨色板（与 web 设计 token 一致） */
const C = {
  bg: '#FBF9F5',
  card: '#F5F1E8',
  ink: '#1E2022',
  sub: '#4B4F54',
  ochre: '#8C7B65',
  vermilion: '#B91C1C',
  bamboo: '#3F6212',
  line: '#E3DDD2',
};

type Screen =
  | { name: 'settings' }
  | { name: 'home' }
  | { name: 'collection'; collection: Collection }
  | { name: 'player'; material: MaterialListItem; from: Collection };

/** 单句：句段行（激活句朱砂左边线） */
function CueRow({ cue, active, onPress }: { cue: CueDTO; active: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={[styles.cueCard, active && styles.cueActive]}>
      {active ? <View style={styles.cueBar} /> : null}
      <View style={{ flex: 1 }}>
        <Text style={styles.cueEn}>{cue.textEn}</Text>
        {cue.textZh ? <Text style={styles.cueZh}>{cue.textZh}</Text> : null}
      </View>
    </Pressable>
  );
}

/** App 组件 */
export default function App() {
  const [screen, setScreen] = useState<Screen>({ name: 'settings' });
  const [urlInput, setUrlInput] = useState(getBaseUrl());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  /* 各屏数据 */
  const [collections, setCollections] = useState<Collection[]>([]);
  const [materials, setMaterials] = useState<MaterialListItem[]>([]);
  const [cues, setCues] = useState<CueDTO[]>([]);
  const [activeCue, setActiveCue] = useState(-1);

  /* 播放器（expo-audio：hook 管理实例，媒体源随材料切换） */
  const player = useAudioPlayer(
    screen.name === 'player' ? { uri: `${getBaseUrl()}/api/media/${screen.material.id}` } : null
  );
  const [playing, setPlaying] = useState(false);

  /** 连接服务（设置屏） */
  const connect = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      setBaseUrl(urlInput.trim());
      const r = await api<{ collections: Collection[] }>('/api/collections');
      setCollections(r.collections);
      setScreen({ name: 'home' });
    } catch (e) {
      setError(e instanceof Error ? e.message : '连接失败');
    } finally {
      setLoading(false);
    }
  }, [urlInput]);

  /** 打开材料集 */
  const openCollection = useCallback(async (c: Collection) => {
    setLoading(true);
    setError(null);
    try {
      const r = await api<{ materials: MaterialListItem[] }>(`/api/collections/${c.id}/materials?page=1&pageSize=50`);
      setMaterials(r.materials);
      setScreen({ name: 'collection', collection: c });
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  /** 打开播放页（装载句段并配置音频） */
  const openMaterial = useCallback(async (m: MaterialListItem, c: Collection) => {
    setLoading(true);
    setError(null);
    try {
      const r = await api<{ cues: CueDTO[] }>(`/api/materials/${m.id}/cues`);
      setCues(r.cues);
      setActiveCue(-1);
      setScreen({ name: 'player', material: m, from: c });
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  /** 播放/暂停切换（expo-audio 同步 API） */
  const togglePlay = useCallback(() => {
    if (screen.name !== 'player') return;
    if (player.playing) {
      player.pause();
      setPlaying(false);
    } else {
      player.play();
      setPlaying(true);
    }
  }, [player, screen]);

  /* 播放状态订阅：currentTime → 激活句跟随高亮（二分查句与 web 端共用
     @pinglc/core 的 findCueIndex；变了才 setState，不做每事件线性扫描） */
  useEffect(() => {
    if (screen.name !== 'player') return;
    const sub = player.addListener('playbackStatusUpdate', (st: AudioStatus) => {
      const t = (st.currentTime ?? 0) * 1000;
      const idx = findCueIndex(cues, t);
      // 句间空隙返回 -1：保留上一句高亮（不闪清、计数不出现「第 0 句」）
      if (idx !== -1) setActiveCue((prev) => (prev === idx ? prev : idx));
      // 播放态以音频事实为准（不读 state——effect 闭包里的 playing 是过期快照，
      // 播放结束/被打断时图标会卡在 ❚❚）
      setPlaying(Boolean(st.playing));
    });
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen.name === 'player' ? screen.material.id : null, player, cues]);

  /* —— 屏幕渲染 —— */

  if (screen.name === 'settings') {
    return (
      <SafeAreaView style={styles.safe}>
        <ExpoStatusBar style="dark" />
        <View style={styles.centerCol}>
          <Text style={styles.title}>纸墨研习斋</Text>
          <Text style={styles.subtitle}>书山万仞吾独取，不向旁人问径蹊</Text>
          <Text style={styles.hint}>输入电脑上 web 服务的局域网地址{'\n'}（如 http://192.168.1.10:3000）</Text>
          <TextInput
            value={urlInput}
            onChangeText={setUrlInput}
            placeholder="http://192.168.1.10:3000"
            placeholderTextColor={C.ochre}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            style={styles.input}
          />
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <Pressable onPress={connect} style={styles.primaryBtn} disabled={loading}>
            {loading ? <ActivityIndicator color={C.bg} /> : <Text style={styles.primaryBtnText}>连接</Text>}
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  if (screen.name === 'home') {
    return (
      <SafeAreaView style={styles.safe}>
        <ExpoStatusBar style="dark" />
        <View style={styles.headerRow}>
          <Text style={styles.h2}>藏经阁</Text>
          <Pressable onPress={() => setScreen({ name: 'settings' })}>
            <Text style={styles.link}>服务设置</Text>
          </Pressable>
        </View>
        {error ? <Text style={[styles.error, { margin: 12 }]}>{error}</Text> : null}
        <FlatList
          data={collections}
          keyExtractor={(c) => String(c.id)}
          contentContainerStyle={{ padding: 12, gap: 8 }}
          refreshControl={
            <RefreshControl
              refreshing={loading}
              onRefresh={async () => {
                const r = await api<{ collections: Collection[] }>('/api/collections').catch(() => null);
                if (r) setCollections(r.collections);
              }}
            />
          }
          renderItem={({ item }) => (
            <Pressable style={styles.card} onPress={() => void openCollection(item)}>
              <Text style={styles.cardTitle}>{item.name}</Text>
              <Text style={styles.cardMeta}>{item.materialCount} 篇</Text>
            </Pressable>
          )}
          ListEmptyComponent={<Text style={styles.empty}>还没有材料集，先在网页端导入</Text>}
        />
      </SafeAreaView>
    );
  }

  if (screen.name === 'collection') {
    return (
      <SafeAreaView style={styles.safe}>
        <ExpoStatusBar style="dark" />
        <View style={styles.headerRow}>
          <Pressable onPress={() => setScreen({ name: 'home' })}>
            <Text style={styles.link}>‹ 藏经阁</Text>
          </Pressable>
          <Text style={styles.h2}>{screen.collection.name}</Text>
        </View>
        {error ? <Text style={[styles.error, { margin: 12 }]}>{error}</Text> : null}
        <FlatList
          data={materials}
          keyExtractor={(m) => String(m.id)}
          contentContainerStyle={{ padding: 12, gap: 8 }}
          renderItem={({ item }) => (
            <Pressable
              style={styles.card}
              onPress={() => void openMaterial(item, screen.collection)}
              disabled={item.subtitleStatus !== 'ready'}
            >
              <Text style={styles.cardTitle}>{item.title}</Text>
              <Text style={styles.cardMeta}>
                {item.subtitleStatus === 'ready' ? `${item.sentenceCount ?? '—'} 句 · 进入精读` : item.subtitleStatus === 'processing' ? '字幕生成中…' : '暂不可学'}
              </Text>
            </Pressable>
          )}
        />
      </SafeAreaView>
    );
  }

  /* player */
  return (
    <SafeAreaView style={styles.safe}>
      <ExpoStatusBar style="dark" />
      <View style={styles.headerRow}>
        <Pressable
          onPress={() => {
            // 先导航（音频状态不阻断返回），随后尽力停音卸载
            setScreen({ name: 'collection', collection: screen.from });
            player.pause();
          }}
        >
          <Text style={styles.link}>‹ 返回</Text>
        </Pressable>
        <Text style={styles.h2} numberOfLines={1}>
          {screen.material.title}
        </Text>
      </View>
      {error ? <Text style={[styles.error, { margin: 12 }]}>{error}</Text> : null}
      {/* 播放条 */}
      <View style={styles.playerBar}>
        <Pressable onPress={togglePlay} style={styles.playBtn}>
          <Text style={styles.playIcon}>{playing ? '❚❚' : '▶'}</Text>
        </Pressable>
        <Text style={styles.playerHint}>第 {activeCue + 1} / {cues.length} 句</Text>
      </View>
      {/* 句段列表（点句跳播） */}
      <FlatList
        data={cues}
        keyExtractor={(c) => String(c.id)}
        contentContainerStyle={{ padding: 12, gap: 8 }}
        renderItem={({ item }) => (
          <CueRow
            cue={item}
            active={item.index === activeCue}
            onPress={() => {
              setActiveCue(item.index);
              player.seekTo(item.startMs / 1000 + 0.01);
              player.play();
              setPlaying(true);
            }}
          />
        )}
      />
    </SafeAreaView>
  );
}

/** 纸墨风样式表 */
const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  centerCol: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12 },
  title: { fontSize: 32, color: C.ink, fontFamily: 'serif' },
  subtitle: { fontSize: 13, color: C.ochre },
  hint: { fontSize: 13, color: C.sub, textAlign: 'center' },
  input: {
    width: '100%',
    borderWidth: 1,
    borderColor: '#D6CEBF',
    borderRadius: 4,
    backgroundColor: C.card,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 15,
    color: C.ink,
  },
  error: { color: '#BA1A1A', fontSize: 13 },
  primaryBtn: { backgroundColor: C.vermilion, borderRadius: 4, paddingHorizontal: 40, paddingVertical: 12 },
  primaryBtnText: { color: C.bg, fontSize: 15 },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 12, borderBottomWidth: 1, borderBottomColor: C.line },
  h2: { fontSize: 20, color: C.ink },
  link: { color: C.ochre, fontSize: 14 },
  card: { backgroundColor: C.card, borderWidth: 1, borderColor: C.line, borderRadius: 4, padding: 14 },
  cardTitle: { fontSize: 16, color: C.ink },
  cardMeta: { fontSize: 12, color: C.ochre, marginTop: 4 },
  empty: { textAlign: 'center', color: C.sub, marginTop: 32 },
  playerBar: { flexDirection: 'row', alignItems: 'center', gap: 14, padding: 12, borderBottomWidth: 1, borderBottomColor: C.line },
  playBtn: { width: 48, height: 48, borderRadius: 24, backgroundColor: C.vermilion, alignItems: 'center', justifyContent: 'center' },
  playIcon: { color: C.bg, fontSize: 18 },
  playerHint: { color: C.sub, fontSize: 13 },
  cueCard: { flexDirection: 'row', backgroundColor: C.card, borderWidth: 1, borderColor: C.line, borderRadius: 4, padding: 12, gap: 8 },
  cueActive: { borderColor: 'rgba(185,28,28,0.5)', backgroundColor: 'rgba(185,28,28,0.04)' },
  cueBar: { width: 3, borderRadius: 2, backgroundColor: C.vermilion },
  cueEn: { fontSize: 15, color: C.ink, lineHeight: 22 },
  cueZh: { fontSize: 13, color: C.sub, marginTop: 4 },
});
