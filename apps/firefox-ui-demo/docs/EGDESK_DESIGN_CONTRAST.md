# EG-Desk 글자·배경 대비 계산 (DSN-03)

기준: 승인 스타일 `docs/egdesk-approved-desktop-style.html`, 값은 `overlay/CSS/eg-desk-surface.uc.css`의
`--egd-*` 토큰(밝게 = `:root`, 어둡게 = `@media (prefers-color-scheme: dark)`와 `[data-egd-theme="dark"]`).
계산: WCAG 2.x 상대 휘도 대비 `(L1 + 0.05) / (L2 + 0.05)`. `color-mix()`·반투명은
`overlay/resources/EGDeskDesignTokens.sys.mjs`의 `resolveColor`·`compositeOver`로 불투명 값으로 푼 뒤 계산한다.
본문 글자 기준은 4.5:1. 같은 계산을 `scripts/egdesk-palette-tokens.test.mjs`가 매번 다시 하며, 4.5:1 아래로
떨어지면 시험이 실패한다. 계산일 2026-11-17, 실화면 측정은 하지 않았다.

| 글자 토큰 | 배경 토큰 | 밝게 (글자 / 배경) | 대비 | 어둡게 (글자 / 배경) | 대비 |
|---|---|---|---|---|---|
| on-surface | surface | #252A26 / #F4F3EE | 13.14 | #EDECE7 / #262925 | 12.44 |
| on-surface | surface-elevated | #252A26 / #FFFEFA | 14.47 | #EDECE7 / #363934 | 9.90 |
| on-surface | window-alt | #252A26 / #F9F9F6 | 13.84 | #EDECE7 / #30342F | 10.70 |
| on-surface | topbar | #252A26 / #F9F8F4 | 13.74 | #EDECE7 / #2D302C | 11.30 |
| on-surface | user-bubble | #252A26 / #E6EBE3 | 12.07 | #EDECE7 / #485748 | 6.49 |
| on-surface | note | #252A26 / #F5F0DF | 12.80 | #EDECE7 / #49443A | 8.17 |
| on-surface-variant | surface | #646A61 / #F4F3EE | 5.00 | #B5B9AE / #262925 | 7.37 |
| on-surface-variant | surface-elevated | #646A61 / #FFFEFA | 5.51 | #B5B9AE / #363934 | 5.86 |
| on-surface-variant | window-alt | #646A61 / #F9F9F6 | 5.27 | #B5B9AE / #30342F | 6.34 |
| primary | surface-elevated | #49634F / #FFFEFA | 6.54 | #A9C5A9 / #363934 | 6.27 |
| primary | primary-container | #49634F / #E1E8DF | 5.28 | #A9C5A9 / #414F43 | 4.63 |
| on-primary | primary | #FFFEFA / #49634F | 6.54 | #363934 / #A9C5A9 | 6.27 |
| danger-ink | danger-bg | #914A42 / #FCF1EF | 5.81 | #C8ABA5 / #4A3D37 | 4.90 |
| success-ink | success-bg | #2F6F45 / #ECF1EA | 5.27 | #A1BAA6 / #344939 | 4.66 |
| warning-ink | surface-elevated | #806735 / #FFFEFA | 5.32 | #C1B7A0 / #363934 | 5.88 |

결과: 주요 글자·배경 쌍은 두 테마 모두 4.5:1 이상이다. 여유가 가장 적은 쌍은 어둡게의
primary / primary-container(4.63)와 success-ink / success-bg(4.66)이다. 이 표에 없는 것: 경계선
(`--egd-outline`은 장식용 가는 선이라 3:1 대상이 아니며, D-G3 (가)에 따라 대비 증가 설정에서만 진해진다),
아바타 머리글자(별도 시험), Browser 웹페이지와 Terminal 본문(토큰 밖).
