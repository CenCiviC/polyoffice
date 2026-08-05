import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// dev 전용: react-grab — 화면에서 컴포넌트를 집어 소스 참조를 얻는 도구 (deardent와 동일 패턴)
if (import.meta.env.DEV) {
  void import('react-grab')
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
