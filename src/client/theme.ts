/**
 * dsh-zotero — 共享 client 样式（面板 + 浮动文献聊天窗共用）。
 * 与 index.tsx 原 CSS 保持一致，避免两处漂移。
 */
export const CSS = `
.dshz{display:flex;flex-direction:column;height:100%;min-height:0;font-size:12.5px;--dshz-bg:#1b1d21;--dshz-panel:#24272c;--dshz-line:#33373e;--dshz-fg:#d8dbe0;--dshz-dim:#8a919c;--dshz-accent:#4f8cff;}
.dshz *{box-sizing:border-box}
.dshz-h{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid var(--dshz-line);background:var(--dshz-bg);position:sticky;top:0;z-index:3}
.dshz-h .dot{width:8px;height:8px;border-radius:50%;background:var(--dshz-dim);flex:none}
.dshz-h b{font-size:12px;color:var(--dshz-fg)}
.dshz-h .st{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dshz-dim);font-size:11px}
.dshz-btn{background:#2a2e35;color:var(--dshz-fg);border:1px solid var(--dshz-line);border-radius:6px;padding:4px 8px;font-size:11.5px;cursor:pointer;white-space:nowrap}
.dshz-btn:hover{background:#343a43}
.dshz-btn.primary{background:var(--dshz-accent);border-color:transparent;color:#fff}
.dshz-btn:disabled{opacity:.5;cursor:default}
.dshz-tabs{display:flex;gap:2px;padding:6px 8px 0;border-bottom:1px solid var(--dshz-line)}
.dshz-tab{padding:5px 10px;border-radius:6px 6px 0 0;cursor:pointer;color:var(--dshz-dim);border:1px solid transparent}
.dshz-tab.on{color:var(--dshz-accent);border-color:var(--dshz-line);border-bottom-color:transparent;background:var(--dshz-panel)}
.dshz-b{flex:1;min-height:0;overflow:auto;background:var(--dshz-panel);padding:8px}
.dshz-row{padding:7px 8px;border:1px solid var(--dshz-line);border-radius:8px;margin-bottom:6px;background:#202329;cursor:pointer}
.dshz-row:hover{border-color:var(--dshz-accent)}
.dshz-row .t{color:var(--dshz-fg);font-size:12.5px;line-height:1.35}
.dshz-row .m{color:var(--dshz-dim);font-size:11px;margin-top:3px;display:flex;gap:8px;flex-wrap:wrap}
.dshz-badge{font-size:10px;border-radius:4px;padding:1px 5px;background:#31353d;color:var(--dshz-dim)}
.dshz-badge.pdf{background:#2c3e50;color:#7fb3ff}
.dshz-badge.summary{background:#2c3e50;color:#7fb3ff}
.dshz-input{width:100%;background:#1e2126;border:1px solid var(--dshz-line);border-radius:6px;color:var(--dshz-fg);padding:5px 8px;font-size:12px}
.dshz-sel{background:#1e2126;border:1px solid var(--dshz-line);border-radius:6px;color:var(--dshz-fg);padding:4px 6px;font-size:11.5px;width:100%}
.dshz-kv{color:var(--dshz-dim);font-size:11px}
.dshz-kv b{color:var(--dshz-fg);font-weight:500}
.dshz-note{color:var(--dshz-dim);font-size:11px;line-height:1.5}
.dshz-banner{border-radius:6px;padding:6px 8px;font-size:11px;margin-bottom:8px}
.dshz-banner.err{background:#3a2020;color:#ff9c9c}
.dshz-banner.ok{background:#1d3324;color:#8fd9a0}
.dshz-null{padding:18px 8px;text-align:center;color:var(--dshz-dim);font-size:12px}
.dshz-pdf{position:relative;border:1px solid var(--dshz-line);border-radius:8px;background:#111;margin-bottom:8px;overflow:hidden}
.dshz-pdf iframe{display:block;width:100%;height:420px;border:0}
.dshz-pdf .bar{position:absolute;top:4px;right:4px;z-index:2;display:flex;gap:4px}
.dshz-field{margin-bottom:8px}
.dshz-field label{display:block;color:var(--dshz-dim);font-size:11px;margin-bottom:2px}
.dshz-sec{color:var(--dshz-fg);font-size:12px;font-weight:600;margin:10px 0 6px;border-bottom:1px solid var(--dshz-line);padding-bottom:3px}
/* ── 浮动文献聊天窗 ── */
.dshz-win{position:fixed;z-index:9999;display:flex;flex-direction:column;background:#1c1f24;border:1px solid #3a3f47;border-radius:10px;box-shadow:0 12px 40px rgba(0,0,0,.55);overflow:hidden;font-size:12.5px;color:var(--dshz-fg)}
.dshz-win[data-hidden="1"]{display:none}
.dshz-win-head{display:flex;align-items:center;gap:6px;padding:6px 8px;background:#23262c;border-bottom:1px solid var(--dshz-line);cursor:move;user-select:none}
.dshz-win-head b{font-size:12px;color:var(--dshz-fg)}
.dshz-win-body{display:flex;flex:1;min-height:0}
.dshz-win-side{width:170px;flex:none;border-right:1px solid var(--dshz-line);background:#1e2126;overflow:auto}
.dshz-win-side .side-item{padding:6px 8px;font-size:11.5px;color:var(--dshz-dim);cursor:pointer;border-bottom:1px solid #262a30;line-height:1.35}
.dshz-win-side .side-item:hover{background:#262a31}
.dshz-win-side .side-item.on{background:#2b3444;color:#cfe3ff}
.dshz-win-main{flex:1;min-width:0;display:flex;flex-direction:column}
.dshz-chat-msgs{flex:1;min-height:0;overflow:auto;padding:8px}
.dshz-msg{margin:4px 0}
.dshz-msg .who{font-size:10px;color:var(--dshz-dim);margin-bottom:2px}
.dshz-msg .bubble{white-space:pre-wrap;word-break:break-word;background:#22262c;border:1px solid var(--dshz-line);border-radius:8px;padding:5px 8px;font-size:12.5px}
.dshz-msg.user .bubble{background:#24313f}
.dshz-msg .run::after{content:"▍";animation:dshz-blink 1s steps(2) infinite}
@keyframes dshz-blink{50%{opacity:0}}
.dshz-pills{display:flex;gap:4px;flex-wrap:wrap;padding:6px 8px;border-top:1px solid var(--dshz-line)}
.dshz-inputrow{display:flex;gap:6px;padding:6px 8px;border-top:1px solid var(--dshz-line)}
`
