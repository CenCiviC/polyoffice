/**
 * 편집기를 진짜 Chrome에 띄워 화면을 찍는다 — **눈으로 확인하기 위한 도구**.
 *
 * 왜 필요한가: 타입 검사·러스트 테스트·IR 계약 검증을 다 통과해도 화면은 깨질 수 있다.
 * 실제로 이 도구가 잡은 것들 — 툴바가 두 줄로 접힘, 결합문자 아이콘(A⃠)이 폰트에서 깨짐,
 * 페이지 설정에서 비균일 여백이 아무 데도 안 보임. 셋 다 자동 테스트는 전부 초록이었다.
 *
 * 쓰는 법:
 *   bun run dev                 # 다른 터미널에서 먼저
 *   bun run shots [문서] [출력디렉터리]
 *
 * 브라우저는 설치된 것을 쓴다(내려받지 않는다). 경로는 CHROME 환경변수로 바꿀 수 있다.
 */
import puppeteer from 'puppeteer-core'
import { mkdirSync } from 'node:fs'

const CHROME =
  process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const DOC = process.argv[2] ?? 'samples/hwpx/moef_2026세제개편안_보도자료.hwpx'
const OUT = process.argv[3] ?? 'shots'
const URL = process.env.NARRO_URL ?? 'http://localhost:5173/'

mkdirSync(OUT, { recursive: true })

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 })

/** 콘솔 오류는 화면에 안 보이므로 따로 모은다 — 스크린샷만 보면 놓친다 */
const problems: string[] = []
page.on('console', (m) => m.type() === 'error' && problems.push(`console: ${m.text()}`))
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`))

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const shot = async (name: string) => {
  await page.screenshot({ path: `${OUT}/${name}.png` })
  console.log(`  📸 ${name}.png`)
}
/** 툴바/앱바 버튼을 title 앞부분으로 찾아 누른다 */
const click = async (titlePrefix: string) => {
  const el = await page.$(`[title^="${titlePrefix}"]`)
  if (!el) {
    problems.push(`버튼을 못 찾음: ${titlePrefix}`)
    return false
  }
  await el.click()
  await wait(400)
  return true
}

try {
  await page.goto(URL, { waitUntil: 'networkidle2' })
} catch {
  console.error(`${URL} 에 접속 못 함 — 먼저 \`bun run dev\`를 띄우세요.`)
  await browser.close()
  process.exit(1)
}
await shot('01-empty')

const input = await page.$('input[type=file][accept*=hwp]')
if (!input) throw new Error('파일 input을 못 찾음')
await input.uploadFile(DOC)
await page.waitForSelector('iframe.page', { timeout: 20000 })
await wait(2500) // 파싱 + 페이지네이션
await shot('02-document')

/** 툴바 컨트롤 수 — 표 조작은 표 안에서만 나와야 한다 */
const controls = () => page.evaluate(() => document.querySelectorAll('.fmtbar button, .fmtbar select').length)
const outside = await controls()

if (await click('개요 보기')) await shot('03-outline')
await click('개요 보기')

// 표 안을 클릭하면 행·열·병합이 나타나는가
const frameBox = await (await page.$('iframe.page'))!.boundingBox()
const cell = await page.evaluate(() => {
  const d = (document.querySelector('iframe.page') as HTMLIFrameElement).contentDocument
  const td = d?.querySelector('td')
  if (!td) return null
  const r = td.getBoundingClientRect()
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
})
if (cell && frameBox) {
  await page.mouse.click(frameBox.x + cell.x, frameBox.y + cell.y)
  await wait(600)
  const inside = await controls()
  console.log(`  툴바 컨트롤: 표 밖 ${outside} → 표 안 ${inside}`)
  if (inside <= outside) problems.push('표 안에서 표 조작 버튼이 안 나타난다')
  await shot('04-table-context')
}

if (await click('페이지 설정')) await shot('05-page-setup')
await page.keyboard.press('Escape')
await wait(300)

// 문서 안 글자를 골라 링크를 건다
await page.evaluate(() => {
  const d = (document.querySelector('iframe.page') as HTMLIFrameElement).contentDocument!
  const p = Array.from(d.querySelectorAll('p')).find((el) => (el.textContent ?? '').trim().length > 6)
  const t = p?.firstChild?.firstChild ?? p?.firstChild
  if (!t) return
  const range = d.createRange()
  range.setStart(t, 0)
  range.setEnd(t, Math.min(4, (t.textContent ?? '').length))
  const sel = d.getSelection()!
  sel.removeAllRanges()
  sel.addRange(range)
})
await wait(200)
if (await click('링크')) {
  await page.type('.link-input', 'mois.go.kr/manual')
  await wait(250)
  await shot('06-link-dialog')
  for (const b of await page.$$('.dialog-foot button')) {
    if ((await page.evaluate((e) => e.textContent, b)) === '적용') await b.click()
  }
  await wait(800)
  await shot('07-link-applied')
}

// 편집기 안 DOM이 실제로 새 어휘를 담고 있는지
const dom = await page.evaluate(() => {
  const d = (document.querySelector('iframe.page') as HTMLIFrameElement).contentDocument!
  return {
    링크: d.querySelector('a[href]')?.outerHTML.slice(0, 120) ?? '(없음)',
    위첨자: d.querySelectorAll('sup').length,
    아래첨자: d.querySelectorAll('sub').length,
    들여쓴문단: d.querySelectorAll('[style*="margin-left"]').length,
    구역: d.querySelector('doc-section')?.getAttribute('style') ?? '',
  }
})
console.log('\n편집기 안 DOM:')
for (const [k, v] of Object.entries(dom)) console.log(`  ${k}: ${v}`)

console.log(problems.length ? `\n⚠️ 문제 ${problems.length}건:` : '\n✓ 콘솔 오류 없음')
for (const p of problems) console.log('  ' + p)

await browser.close()
process.exit(problems.length ? 1 : 0)
