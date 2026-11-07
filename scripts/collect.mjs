// 이번 주 클로드 강의 수집 스크립트.
// 1) 채널 업로드 목록에서 최근 7일 영상 수집 → 2) 쇼츠 제외, "클로드/Claude" 포함 영상만 후보
// → 3) Gemini로 관련성·분야·입문 여부·한 줄 요약 → 4) overrides.json 반영 → public/videos.json
// 필요한 환경 변수: YOUTUBE_API_KEY, GEMINI_API_KEY (둘 다 이 스크립트 밖에 저장하지 않는다)
// 선택: GEMINI_MODEL, PRIOR_URL(이전 결과 주소, 기존 분류 재사용), OUT, YT_API_BASE, GEMINI_API_BASE
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const YT_KEY = process.env.YOUTUBE_API_KEY;
const GM_KEY = process.env.GEMINI_API_KEY;
if (!YT_KEY || !GM_KEY) {
  console.error('YOUTUBE_API_KEY와 GEMINI_API_KEY 환경 변수가 필요해요.');
  process.exit(1);
}
const YT = process.env.YT_API_BASE ?? 'https://www.googleapis.com/youtube/v3';
const GM = process.env.GEMINI_API_BASE ?? 'https://generativelanguage.googleapis.com/v1beta';
const MODEL = process.env.GEMINI_MODEL ?? 'gemini-3.5-flash-lite';
const OUT = process.env.OUT ?? 'public/videos.json';
const PRIOR_URL = process.env.PRIOR_URL ?? 'https://seoyuwls.github.io/weekly-claude-data/videos.json';
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_SEC = 180; // 3분 이하(쇼츠 포함) 제외. 쇼츠 판별 방식은 확인 필요
const CATEGORIES = ['활용', '디자인', '개발'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function yt(path, params) {
  const res = await fetch(`${YT}/${path}?${new URLSearchParams(params)}`, { headers: { 'x-goog-api-key': YT_KEY } });
  if (!res.ok) throw new Error(`${path} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

function toSeconds(iso) {
  const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso) ?? [];
  return (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0);
}

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    relevant: { type: 'BOOLEAN' },
    category: { type: 'STRING', enum: CATEGORIES },
    beginner: { type: 'BOOLEAN' },
    summary: { type: 'STRING' },
  },
  required: ['relevant', 'category', 'beginner', 'summary'],
};

const RULES = `너는 클로드(Anthropic Claude)를 배우는 사람을 위한 강의 영상 분류기야. 아래 기준으로 JSON만 답해.
- relevant: 영상의 제목이나 핵심 내용이 클로드(채팅·프로젝트·코워크·스킬·커넥터·클로드 코드·클로드 디자인 등)를 쓰는 방법과 기능을 직접 다룰 때만 true. 책·강의 홍보, 일반적인 AI 시사·트렌드 모음, 다른 AI 도구 비교가 중심이거나 클로드가 잠깐 언급되거나 광고·링크로만 나오면 false.
- category: 활용(채팅·프로젝트·코워크·스킬·커넥터로 업무 처리, 코딩 없음) / 디자인(클로드 디자인, 피그마 연동, UI·디자인 시스템) / 개발(클로드 코드, 바이브 코딩, MCP·API, 앱·웹 만들기). 업데이트·신기능 소개 영상은 다루는 내용에 가장 가까운 분야로 분류해.
- beginner: 설치·가입·기본 화면부터 설명하고 사전 지식 없이 따라 할 수 있을 때만 true. 서버·터미널 설정, 도구 비교, 심화 개념, 자동화 구축은 false. 제목·설명에 처음, 기초, 입문, 왕초보, 따라하기가 있으면 참고만 하고 내용으로 판단해.
- summary: 35자 이내 해요체 한 문장, 마침표 없이. 이 영상을 보면 무엇을 할 수 있는지 중심. 과장 표현(완벽, 끝판왕, 미친 등)과 제목의 자극적 표현은 옮기지 마. 예: 클로드 코드를 설치하고 첫 웹페이지를 만들어요`;

async function gemini(parts, attempt = 0) {
  const res = await fetch(`${GM}/models/${MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': GM_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts }],
      generationConfig: { responseMimeType: 'application/json', responseSchema: SCHEMA, temperature: 0.2 },
    }),
  });
  // 한도 초과(429)나 일시적 서버 오류(500·503)는 간격을 늘려 다시 시도한다.
  if ([429, 500, 503].includes(res.status) && attempt < 3) {
    await sleep(10000 * 2 ** attempt);
    return gemini(parts, attempt + 1);
  }
  if (!res.ok) {
    const err = new Error(`gemini ${res.status}: ${(await res.text()).slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  const json = await res.json();
  const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
  return JSON.parse(text);
}

function metaText(v) {
  return `제목: ${v.title}\n채널: ${v.channelName}\n설명: ${v.description.slice(0, 1500)}`;
}

// 영상 자체를 보고 분류하고, 한도 초과·실패 시 제목·설명만으로 분류한다.
async function classify(v) {
  try {
    const r = await gemini([
      { text: `${RULES}\n\n${metaText(v)}` },
      { file_data: { file_uri: `https://www.youtube.com/watch?v=${v.id}` } },
    ]);
    return { ...r, summarySource: 'video' };
  } catch (e) {
    console.warn(`영상 분석 실패, 제목·설명으로 대체: ${v.id} — ${e.message}`);
    const r = await gemini([{ text: `${RULES}\n\n${metaText(v)}` }]);
    return { ...r, summarySource: 'text' };
  }
}

async function loadPrior() {
  try {
    const res = await fetch(PRIOR_URL);
    if (!res.ok) return { videos: [], checked: [] };
    const j = await res.json();
    return { videos: j.videos ?? [], checked: j.checked ?? [] };
  } catch {
    return { videos: [], checked: [] };
  }
}

// 유튜브 인기 댓글(관련도순) 최대 3개. 댓글을 막아 둔 영상은 오류가 나므로 빈 목록으로 둔다.
async function topComments(id) {
  try {
    const r = await yt('commentThreads', { part: 'snippet', videoId: id, order: 'relevance', maxResults: '3', textFormat: 'plainText' });
    return (r.items ?? []).slice(0, 3).map((i) => {
      const c = i.snippet.topLevelComment.snippet;
      return { author: c.authorDisplayName, text: String(c.textDisplay).replace(/[ \t]+/g, ' ').trim().slice(0, 220), likeCount: c.likeCount ?? 0 };
    });
  } catch {
    return [];
  }
}

const channels = JSON.parse(await readFile('channels.json', 'utf8'));
const overrides = JSON.parse(await readFile('overrides.json', 'utf8'));
const prior = await loadPrior();
const priorById = new Map(prior.videos.map((v) => [v.id, v]));
const checkedSet = new Set(prior.checked);
const since = Date.now() - WEEK_MS;

// 1~2) 후보 수집
console.log(`채널 ${channels.length}곳 조회 시작`);
const candidates = [];
const seenIds = new Set();
let channelFailures = 0;
for (const ch of channels) {
  try {
    const c = await yt('channels', { part: 'contentDetails', forHandle: ch.handle });
    const uploads = c.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
    if (!uploads) { console.warn(`건너뜀: ${ch.handle} (채널을 찾지 못함)`); channelFailures += 1; continue; }
    const pl = await yt('playlistItems', { part: 'contentDetails', playlistId: uploads, maxResults: '20' });
    const recent = pl.items.filter((i) => new Date(i.contentDetails.videoPublishedAt).getTime() >= since);
    if (!recent.length) continue;
    const v = await yt('videos', { part: 'contentDetails,snippet', id: recent.map((i) => i.contentDetails.videoId).join(',') });
    for (const item of v.items) {
      const durationSec = toSeconds(item.contentDetails.duration);
      const text = `${item.snippet.title} ${item.snippet.description}`;
      if (durationSec <= MIN_SEC || !/클로드|claude/i.test(text)) continue;
      if (seenIds.has(item.id)) continue;
      seenIds.add(item.id);
      candidates.push({
        id: item.id,
        title: item.snippet.title,
        description: item.snippet.description ?? '',
        channelName: ch.name,
        channelHandle: ch.handle,
        publishedAt: item.snippet.publishedAt,
        durationSec,
        thumbnail: item.snippet.thumbnails?.medium?.url ?? '',
      });
    }
  } catch (e) {
    channelFailures += 1;
    console.warn(`실패: ${ch.handle} — ${e.message.slice(0, 200)}`);
  }
}
if (channelFailures === channels.length) {
  console.error('모든 채널 조회에 실패해서 파일을 저장하지 않았어요.');
  process.exit(1);
}

console.log(`후보 ${candidates.length}개 분류 시작 (모델 ${MODEL})`);
// 3) 분류·요약 (이미 한 영상은 재사용)
let n = 0;
const videos = [];
const checked = new Set();
let aiCalls = 0;
let pending = 0;
for (const v of candidates) {
  const { description, ...base } = v;
  n += 1;
  console.log(`[${n}/${candidates.length}] ${v.channelName} — ${v.title.slice(0, 40)}`);
  if (checkedSet.has(v.id)) { checked.add(v.id); continue; }
  let result = priorById.get(v.id);
  if (!result) {
    try {
      const r = await classify(v);
      aiCalls += 1;
      if (!r.relevant) { checked.add(v.id); continue; }
      result = r;
      await sleep(4000);
    } catch (e) {
      pending += 1; // 저장하지 않으면 다음 실행에서 다시 시도한다
      console.warn(`분류 보류: ${v.id} — ${e.message}`);
      continue;
    }
  }
  videos.push({
    ...base,
    category: CATEGORIES.includes(result.category) ? result.category : '활용',
    beginner: result.beginner,
    summary: result.summary.trim().replace(/[.。]+$/, ''),
    summarySource: result.summarySource ?? 'video',
  });
}

// 4) 수동 수정 반영 (숨긴 영상은 다음 실행에서 다시 분석하지 않도록 기록)
for (const v of videos) if (overrides[v.id]?.hide) checked.add(v.id);
const final = videos
  .filter((v) => !overrides[v.id]?.hide)
  .map((v) => {
    const o = overrides[v.id];
    if (!o) return v;
    const { hide, ...rest } = o;
    return { ...v, ...rest };
  })
  .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));

// 댓글은 시간이 지나면 바뀌므로 이전 결과를 재사용하지 않고 매번 새로 받는다.
for (const v of final) v.comments = await topComments(v.id);

const counts = {};
for (const v of final) counts[v.category] = (counts[v.category] ?? 0) + 1;

await mkdir(dirname(OUT), { recursive: true });
await writeFile(
  OUT,
  JSON.stringify({ updatedAt: new Date().toISOString(), videos: final, checked: [...checked].filter((id) => seenIds.has(id)) }, null, 2),
);
console.log(`후보 ${candidates.length}개 중 ${final.length}개 저장 (AI 호출 ${aiCalls}회, 보류 ${pending}개, 채널 실패 ${channelFailures}곳)`);
console.log('분야별:', JSON.stringify(counts), '/ 입문:', final.filter((v) => v.beginner).length);
