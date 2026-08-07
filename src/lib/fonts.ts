/**
 * 이 기기에 실제로 설치된 글꼴 판별.
 *
 * 웹은 CDN으로 어떤 글꼴이든 띄울 수 있지만, docx·hwpx에는 글꼴 파일이 아니라
 * **이름만** 저장된다. 여는 쪽 기기에 그 글꼴이 없으면 워드/한글이 제멋대로 대체하고,
 * 글자 폭이 달라져 첫 줄부터 줄바꿈 위치가 어긋난다. 그래서 편집기는 "있는 척"하는
 * 글꼴을 보여주면 안 된다.
 *
 * document.fonts.check()는 설치되지 않은 글꼴에도 true를 돌려주므로 쓸 수 없다.
 * 같은 문자열을 후보 글꼴과 일반 글꼴로 각각 재서 폭이 다르면 설치된 것으로 본다.
 */

/** 한글·라틴·숫자를 섞어 폭 차이가 잘 드러나게 한다 */
const SAMPLE = '한글Abc가나다123'
const GENERICS = ['monospace', 'serif', 'sans-serif'] as const

export function detectFonts(candidates: string[]): string[] {
  const ctx = document.createElement('canvas').getContext('2d')
  if (!ctx) return candidates

  const baseline = new Map<string, number>()
  for (const g of GENERICS) {
    ctx.font = `40px ${g}`
    baseline.set(g, ctx.measureText(SAMPLE).width)
  }

  return candidates.filter((family) =>
    GENERICS.some((g) => {
      // 후보가 없으면 g로 대체되어 기준값과 같은 폭이 나온다
      ctx.font = `40px "${family}", ${g}`
      return ctx.measureText(SAMPLE).width !== baseline.get(g)
    }),
  )
}

/**
 * 편집기 글꼴 후보 — 윈도우·한글·macOS에 기본 탑재되는 것들.
 * 여기 있다고 다 보여주지 않는다. detectFonts()로 거른 뒤 실제 있는 것만 노출한다.
 */
export const FONT_CANDIDATES = [
  // 한글(HWP) 기본
  '함초롬바탕',
  '함초롬돋움',
  // 윈도우 기본
  '맑은 고딕',
  'Malgun Gothic',
  '바탕',
  '돋움',
  '굴림',
  '궁서',
  // macOS 기본
  'Apple SD Gothic Neo',
  'AppleGothic',
  'AppleMyungjo',
  // 널리 설치되는 무료 글꼴
  'NanumGothic',
  'NanumMyeongjo',
  'Noto Sans KR',
  'Pretendard',
  // 라틴
  'Arial',
  'Times New Roman',
  'Courier New',
]

/**
 * 받는 쪽에서도 있을 가능성이 높은 글꼴(내보내기 안전).
 * 이 목록 밖의 글꼴로 저장하면 상대 기기에서 대체될 수 있다.
 */
const SAFE_FOR_EXPORT = new Set([
  '함초롬바탕',
  '함초롬돋움',
  '맑은 고딕',
  'Malgun Gothic',
  '바탕',
  '돋움',
  '굴림',
  '궁서',
  'Arial',
  'Times New Roman',
  'Courier New',
])

export const isSafeForExport = (family: string) => SAFE_FOR_EXPORT.has(family)
