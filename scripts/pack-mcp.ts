/**
 * `polyoffice-mcp` npm 패키지를 조립한다 — 클론 없이 `npx`로 쓸 수 있게.
 *
 *   claude mcp add polyoffice -- npx -y polyoffice-mcp
 *
 * 레포의 package.json은 앱 것이고 private이다. 여기서 **별도 매니페스트**를 만들어
 * `build/npm/`에 담는다 — 앱 레포의 정체를 건드리지 않으려는 것이다.
 *
 * 레이아웃을 레포와 같게 맞추는 게 요점이다. `scripts/doc-core.ts`가 자산을
 * `import.meta.url` 상대로 읽으므로(`../public/fonts/…`, `../rust/hwp-core/pkg/…`),
 * 번들을 `bin/`(= `scripts/`와 같은 깊이)에 두면 **경로 코드를 고칠 필요가 없다.**
 *
 *   build/npm/
 *     package.json
 *     bin/polyoffice-mcp.js      ← mcp/server.ts 번들 (scripts/와 같은 깊이)
 *     public/blank.hwpx
 *     public/fonts/*.ttf         ← 글꼴 임베딩에 원본이 필요하다
 *     public/app/                ← 편집기 SPA (vite build 결과)
 *     rust/hwp-core/pkg/*.wasm   ← 파서
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const OUT = join(REPO, 'build', 'npm')
const app = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'))

function step(msg: string) {
  console.log(`  ${msg}`)
}

rmSync(OUT, { recursive: true, force: true })
mkdirSync(join(OUT, 'bin'), { recursive: true })

// ── 1. 편집기 SPA — 이게 있어야 정적 서버가 띄울 게 있다
if (!existsSync(join(REPO, 'dist', 'index.html'))) {
  console.error('dist/ 가 없습니다. 먼저 `bun run build`를 실행하세요.')
  process.exit(1)
}
cpSync(join(REPO, 'dist'), join(OUT, 'public', 'app'), { recursive: true })
// 브라우저는 woff2만 쓴다 — TTF는 서버 쪽 글꼴 임베딩용이라 public/fonts/ 한 벌이면 된다
for (const f of ['NotoSansKR-Regular.ttf', 'NotoSansKR-Bold.ttf']) {
  rmSync(join(OUT, 'public', 'app', 'fonts', f), { force: true })
}
// 남의 문서가 실려 나가지 않게 (vite 쪽에서도 지우지만 두 겹으로 막는다)
rmSync(join(OUT, 'public', 'app', 'scratch'), { recursive: true, force: true })
step('편집기 SPA → public/app/ (TTF·scratch 제외)')

// ── 2. 런타임 자산 (경로가 레포와 같아야 한다)
mkdirSync(join(OUT, 'public', 'fonts'), { recursive: true })
for (const f of ['NotoSansKR-Regular.ttf', 'NotoSansKR-Bold.ttf', 'LICENSE-OFL.txt']) {
  cpSync(join(REPO, 'public', 'fonts', f), join(OUT, 'public', 'fonts', f))
}
cpSync(join(REPO, 'public', 'blank.hwpx'), join(OUT, 'public', 'blank.hwpx'))
mkdirSync(join(OUT, 'rust', 'hwp-core', 'pkg'), { recursive: true })
cpSync(
  join(REPO, 'rust', 'hwp-core', 'pkg', 'hwp_core_bg.wasm'),
  join(OUT, 'rust', 'hwp-core', 'pkg', 'hwp_core_bg.wasm'),
)
cpSync(join(REPO, 'LICENSE'), join(OUT, 'LICENSE'))
// polyoffice_guide가 그대로 돌려주는 문서 — bin/에서 ../docs/ 로 읽는다
mkdirSync(join(OUT, 'docs'), { recursive: true })
cpSync(join(REPO, 'docs', 'IR-AUTHORING.md'), join(OUT, 'docs', 'IR-AUTHORING.md'))
// npm 페이지에 걸리는 README — 레포 것(앱 이야기)이 아니라 MCP 서버 이야기다
cpSync(join(REPO, 'mcp', 'README.npm.md'), join(OUT, 'README.md'))
step('글꼴·wasm·템플릿·가이드·README → public/, rust/, docs/')

// ── 3. 매니페스트. 앱 것과 갈라 둔다 (앱은 private, 이건 배포용)
writeFileSync(
  join(OUT, 'package.json'),
  JSON.stringify(
    {
      name: 'polyoffice-mcp',
      version: app.version === '0.0.0' ? '0.1.0' : app.version,
      description:
        '한글(.hwp/.hwpx)·Word(.doc/.docx)·오픈오피스(.odt) 문서를 읽고 고치고 쓰는 MCP 서버 — 파일이 서버로 올라가지 않는다',
      type: 'module',
      bin: { 'polyoffice-mcp': 'bin/polyoffice-mcp.js' },
      files: ['bin/', 'public/', 'rust/', 'docs/', 'LICENSE', 'README.md'],
      engines: { node: '>=20' },
      license: 'Apache-2.0',
      repository: { type: 'git', url: 'git+https://github.com/CenCiviC/polyoffice.git' },
      homepage: 'https://github.com/CenCiviC/polyoffice',
      keywords: ['mcp', 'hwp', 'hwpx', 'docx', 'odt', 'hangul', 'korean', 'document'],
    },
    null,
    2,
  ) + '\n',
)
step('package.json (polyoffice-mcp)')

console.log('\n번들은 `bun run pack:mcp`가 이어서 만듭니다.')
