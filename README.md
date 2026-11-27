# SafeMove

HFS 3 的大檔案跨硬碟遷移引擎。它不取代 HFS，而是在 **`move_files` / `copy_files` API 這一層**接手符合條件的搬移或複製：

- 檔案大小 ≥ 門檻（預設 100 MB）
- 來源與目的在不同的磁碟區（`st.dev` 不同）

符合條件時改用本插件的伺服器端隊列：**斷點續傳 → 限速 → 完成後 SHA-256 校驗 → 原子改名**；move 完成後刪除來源，copy 則保留來源。不符合條件的（同磁碟、小檔案、資料夾、沒有讀取權限、符號連結）一律交回 HFS 原生流程，同磁碟搬移仍然是瞬間完成的 rename、同磁碟複製仍走原生 `copyFile` / FICLONE。

介面會在檔案瀏覽頁的 header 內、`<div id="folder-stats">` 正下方，按登入帳號各自顯示每一筆傳輸的進度列；完成後顯示校驗結果並倒數 10 秒消失。所有跨硬碟工作由同一個隊列逐個執行。

![執行中的進度列](docs/preview-running.png)

---

## 功能

- **只攔截真正需要的情形**：`move_files` / `copy_files` 進入時先做一次輕量分類；沒有任何大檔案跨磁碟時，直接放行原生 API，几乎沒有額外成本。
- **與 copy-files 聯動**：copy-files 不需要修改；它照舊在 paste 時呼叫 `copy_files`，SafeMove 在 HTTP 層接手大型跨磁碟複製。copy 完成後保留來源，只建立目的檔。
- **與 Clipboard-Sync 聯動**：SafeMove 1.6 提供 `safemove_move` / `safemove_copy`；Clipboard-Sync 2.3 起在 cut 與 copy 貼上時都會先找它。兩者同時存在時，跨裝置貼上的大檔也會進 SafeMove 隊列；SafeMove 未安裝、停用或版本太舊時，自動回退原生 `moveFiles` / `copy_files`。
- **斷點續傳**：資料寫入目的磁碟的 `<檔名>.part`（預設可見），中斷（頁面刷新、伺服器重啟、磁碟忙碌、程式被終止）後從已完成的位元組繼續。
- **限速**：預設 **0（不限速）**，可依伺服器負載設定每秒 MB 上限（例如 6 或 10 MB/s）；面板顯示即時速度。
- **完整性校驗**：完成後對來源與目的各算一次雜湊（預設 SHA-256，可選 MD5 或只比大小），不一致就自動重來一次；再失敗則停下來讓使用者決定。
- **自動重試**：可設定次數與延遲；暫時性錯誤自動排回隊列，續傳不會從頭開始。
- **衝突處理**：目的檔已存在時，預設在進度列旁顯示 **覆蓋 / 重新命名 / 跳過** 小按鈕；也可在設定中固定為覆蓋、重新命名或跳過。
- **暫停 / 繼續 / 中止**：進行中或排隊中的工作可以暫停（保留 `.part`，稍後繼續），也可以中止（刪除 `.part` 與工作）；衝突或失敗時可跳過。
- **中斷提示**：HFS 重啟、程式被砍、熱更新時，工作會標記為 `interrupted`，不會自動續傳；進入來源或目的資料夾時，面板會問要「繼續」還是「刪除殘缺檔」。
- **帳號隔離**：進度只回傳給建立工作的帳號；即時通知通道用 HMAC 派生，其他帳號無法訂閱。
- **重啟後續傳**：工作狀態存在 `storage/jobs.json`；預設在目的資料夾留下 `<檔名>.part`，重啟後用它續傳。也可切換成隱藏 `.hfs-safemove` 資料夾。
- **保留時間戳**：完成後還原來源的修改時間與唯讀屬性，盡量貼近原生 rename 的結果。

## 三者聯動（copy-files + Clipboard-Sync + SafeMove）

copy-files **完全不修改**；它仍然只做兩件事：提供 Copy 選單、在 paste 時呼叫 `copy_files`。另外兩隻插件在它周圍補上同步與引擎：

```
Cut / Move
  Clipboard-Sync._clipSync_paste
      ↓ api.customApiCall('safemove_move', uris, to, ctx)
  SafeMove.smartTransfer('move')
      ├─ 大型跨磁碟 → SafeMove 隊列（完成後刪除來源）
      └─ 其他 → 原生 moveFiles

Copy
  copy-files「Copy」
      ↓ HFS.state.clip.__copy = true
  Clipboard-Sync 發佈 kind=copy（僅當 copy-files 在伺服器端運行）
      ↓ 其他裝置套用 copy 剪貼板
  copy-files「Paste」→ HFS.apiCall('copy_files')
      ↓
  SafeMove.smartTransfer('copy')
      ├─ 大型跨磁碟 → SafeMove 隊列（保留來源）
      └─ 其他 → 原生 copy_files
```

- SafeMove 以**靜態** `exports.customApi` 暴露 `safemove_move` / `safemove_copy`，並保留 `fastmove_move` / `fastmove_copy` 別名給舊版；因為 HFS 的 `customApiCall` 只讀插件資料上的靜態欄位。
- Clipboard-Sync 2.3 會先試 `safemove_move`，再試 `fastmove_move`，最後才回退 `moveFiles`；找不到、呼叫失敗或 SafeMove 停用時都維持原生行為。
- **copy 剪貼板同步的閘門**：只有 copy-files 在伺服器端運行時，Clipboard-Sync 才接受/套用 `kind=copy`。否則 copy 剪貼板只留在本地，避免被當成 move 執行。
- copy 工作完成後來源仍在，只建立目的檔；進度列、限速、校驗、續傳、重試、衝突按鈕都與 move 共用。
- copy-files 在 paste 完成後會把 `clip.length` 清成 0；Clipboard-Sync 會偵測這個原地變更並清掉伺服器端的 copy 剪貼板，其他裝置不會留下過期剪貼板。
- 舊版 Clipboard-Sync 2.0 或更舊沒有 copy 同步；建議一起更新。舊版 FastMove 1.1 只支援 move。

![copy-files → Clipboard-Sync → SafeMove](docs/preview-three.png)

## 安裝

1. 把整個 `SafeMove` 資料夾放進 HFS 的 `plugins` 資料夾（與 `config.yaml` 同層）。
2. 在 Admin → Options → Plugins 重新載入外掛，或在 Plugins 頁面停用再啟用 `SafeMove`。
3. 開啟 Admin → Options → Plugins → `SafeMove` 調整設定。

資料夾名稱必須是 `SafeMove`（安裝後的插件識別名稱）。要發佈到 GitHub 時，把資料夾內容放進 repo 的 `dist/`，repo 名稱使用 `hfs-SafeMove`。

```
SafeMove/
├── plugin.js             後端：攔截、隊列、續傳、校驗、REST
├── engine.js             純 Node 的複製/雜湊引擎（可獨立測試）
├── public/
│   ├── main.js           header 進度面板
│   └── style.css         面板樣式
├── hfs-lang-zh-TW.json   繁中字串
├── hfs-lang-zh.json      簡中字串
└── README.md
```

## 設定

| 設定 | 預設 | 說明 |
|---|---|---|
| Enable SafeMove | 開 | 關閉後完全走原生流程 |
| Large-file threshold (MB) | 100 | 達到這個大小且跨磁碟才接手（move 與 copy 都適用） |
| Migration speed limit (MB/s) | 0 | 0 = 不限速（預設）；只影響複製階段 |
| Verification speed limit (MB/s) | 0 | 校驗讀取的限制，0 = 不限速 |
| Incomplete transfers | Visible `.part` | `Visible .part file` 會在目的資料夾留下 `<檔名>.part`；`Hidden temp folder` 則收進 `.hfs-safemove` |
| Incomplete suffix | `.part` | 可見模式的副檔名標記；校驗通過後才改名去掉 |
| Integrity check | SHA-256 | SHA-256 / MD5 / Size only |
| Automatic retries | 3 | 暫時性錯誤的自動重試次數 |
| Retry delay (seconds) | 5 | 每次重試的基礎延遲（遞增，最多 5 倍） |
| When destination exists | Ask | Ask / Overwrite / Rename / Skip |
| Keep completed row (seconds) | 10 | 校驗結果停留時間 |
| Treat same-disk moves as cross-disk (testing) | 關 | 測試用；也可用來對同碟大檔限速 |

> 這頁就是 HFS 原生的插件設定面板，不需要另外開一個管理頁。

## 使用

1. 以有 `can_read` / `can_delete`（來源）與 `can_upload`（目的）權限的帳號登入。
2. **Move**：剪下（Cut）大檔案，前往另一個磁碟的資料夾貼上（Paste）。
3. **Copy**：用 copy-files 的 Copy 選單，前往目的資料夾貼上；來源會保留。
4. 符合條件的工作會出現在 header 的進度列；原生 toast 可能先顯示完成，但實際檔案會在進度列完成後才出現在目的資料夾（面板完成時會自動刷新目前資料夾）。
5. 進度列右側：**Pause** 暫停（保留 `.part`）、**Abort** 中止（刪除 `.part`）；等待衝突時是 Overwrite / Rename / Skip。
6. 若 HFS 重啟或工作被中斷，進入來源或目的資料夾時，面板頂部會出現「未完成傳輸」提示，可按 **Resume** 或 **Delete partial**（刪除殘缺檔）。

copy 剪貼板要跨裝置同步，copy-files 必須在 HFS 的插件頁保持啟用；否則 copy 只留在本機（不會被誤當成 move）。

面板只顯示目前登入帳號的工作。重新整理頁面不會中斷傳輸；重新開啟頁面會接回現有進度。

## 它是怎麼運作的

```
POST /~/api/move_files 或 /~/api/copy_files
        │
        ├─ pluginsMiddleware（SafeMove.middleware）
        │      ├─ 分類：大小、磁碟、權限、符號連結、WebDAV 鎖
        │      ├─ 不符合 → 不設定回應，native apiMiddleware 照常執行
        │      └─ 符合 → 建立 job、回傳 errors、ctx.stop()
        │
        └─ 背景 worker（同時只跑一個 job）
               ├─ 暫存檔：<dest>\<檔名>.part（預設可見；可切換 .hfs-safemove 隱藏）
               ├─ 續傳：以暫存檔大小為 offset，r+ 接著寫
               ├─ 限速：每寫 1 MiB 依目標速率 sleep
               ├─ 校驗：SHA-256(來源) vs SHA-256(暫存檔)
               ├─ 發佈：rename(暫存檔 → 目的)，還原 mtime/mode
               └─ 清理：move 搬移 uploader 屬性並刪除來源；copy 保留來源
```

### 關於 `/~/admin/#/options/uploads`

本插件沒有把檔案再經由 HTTP 迴環丟給 HFS 的上傳端點，因為那會多一次網路/協定開銷，也需要另外處理登入與路徑映射。它借鑒的是同一套設計：

- 先寫 `<檔名>.part`，完成後才 rename 到正式檔名（半成品不會以正式名稱出現）
- 用 offset 續傳，而不是整檔重來
- 完成後才動來源檔
- 尊重 `isUploading()`：正在上傳中的檔案不碰
- 暫存檔放在目的磁碟，rename 才是同區原子操作

## 已知限制

- **只處理檔案**：資料夾、符號連結維持原生行為。
- **可見 `.part` 是可被存取的檔案**：它會出現在檔案清單，也可能被下載。若不想讓使用者看到半成品，把 Incomplete transfers 改成 `Hidden temp folder`。
- **copy 剪貼板同步需要 copy-files**：SafeMove 只接手 `copy_files` 的傳輸；跨裝置的 copy 剪貼板由 Clipboard-Sync 同步，且必須 copy-files 在伺服器端運行。copy-files 不存在/停用時，copy 仍可用，但只留在本機。
- **校驗成本**：SHA-256 會把來源與目的各讀一次；若幾百 GB 且要極低負載，可把 Verification speed limit 設小，或改用 Size only。
- **不是硬連結/稀疏檔/ADS 的完整複製器**：一般檔案内容與時間戳會保留，Windows 的 Alternate Data Streams 不會。
- **依賴 HFS 內部模組**：使用了 `./vfs`、`./frontEndApis`、`./upload`、`./uploadOwners`、`./webdav`、`./misc`。已把 `apiRequired` 鎖在 13.73（HFS 3.4.2）；升級 HFS 後若內部 API 變動，需要調整。
- **同一時間只跑一個跨磁碟工作**（這是刻意的），同磁碟與小檔案不受影響。
- 若目的磁碟根目錄不可寫，暫存資料夾會退回目的資料夾內的 `.hfs-safemove/`；此時檔案清單可能短暫看到隱藏資料夾（Windows 會嘗試加上 hidden 屬性）。

## 開發與測試

`engine.js` 不依賴 HFS，可直接跑：

```bash
node SafeMove/tests/engine.test.js
```

測試內容：中斷後從 offset 續傳、限速誤差、hash 比對、重新命名。

整合測試（需要一個隔離的 HFS 3.4.2 站台，例如 `--cwd` 指向暫存資料夾、port 8099）：

```bash
node SafeMove/tests/ui.test.mjs        # header 面板、進度條、按鈕
node SafeMove/tests/ui-action.test.mjs # 按鈕操作、完成列、10 秒倒數
node SafeMove/tests/three.test.mjs     # copy-files + Clipboard-Sync + SafeMove 三者聯動
node SafeMove/tests/prompt.test.mjs    # 中斷後進入來源/目的資料夾的 Resume / Delete partial 提示
```

UI 測試假設站台使用 `tester` / `secret123`，VFS 有 `/src` 與 `/dst`；兩個 UI 測試需要預先建立進行中與衝突工作。三者聯動測試需要 copy-files/Clipboard-Sync/SafeMove 都啟用，預設連 `127.0.0.1:8095`，可用 `THREE_ROOT` 指向測試站台資料夾。中斷提示測試預設連 `127.0.0.1:8092`，可用 `PROMPT_ROOT` 指向站台資料夾。它們是開發時的重現腳本，不是零設定的 CI 測試。

本次開發已驗證：

- 50 MB / 20 MB/s：完成、SHA-256 一致、來源刪除
- 200 MB 傳輸中強制砍掉 HFS：重啟後從 44 MB 續傳，最終 hash 一致
- 同磁碟 50 MB：55 ms 原生完成，不進隊列
- 衝突：等待按鈕 → 覆蓋成功；重新命名成功；跳過保留原檔
- 兩個工作同時送出：第二個顯示 `Queued #1`
- 暫停 / 繼續：`paused` 時 `.part` 保留；Resume 後從 `.part` 大小繼續，完成才改名
- 中斷：傳輸中砍掉 HFS，重啟後狀態是 `interrupted`（不自動續傳）；進入 `/dst/` 出現提示，Resume 後從 3 MB 續傳、hash 一致
- 中止：提示按 Delete partial 後工作消失、`.part` 刪除、來源保留
- 兩種帳號：彼此看不到對方工作；SSE 通道錯用回 403
- Clipboard-Sync 2.3 + SafeMove 1.6：`_clipSync_paste` 回報 `moved:1`，來源在貼上後仍在，SafeMove 顯示進度，完成後 hash 一致
- Clipboard-Sync 2.3 + SafeMove 停用：自動回退原生 `moveFiles`，貼上立即完成、hash 一致
- `copy_files` 20 MB 跨碟：job `op=copy`，完成後 hash 一致、來源保留、目的建立；SafeMove 停用時走原生 `copy_files`
- 可見 `.part`：傳輸中出現 `m1.bin.part`；砍掉 HFS 後 `.part` 保留 5 MB，重啟從 6 MB 續傳，完成後 `.part` 改名為 `m1.bin`、hash 一致
- copy-files + Clipboard-Sync + SafeMove：copy 剪貼板跨裝置發佈、paste 由 copy-files 執行、SafeMove 以 copy 隊列接手、完成後 copy-files 清除剪貼板也同步清除
- copy-files 停用：`copySupported=false`，Clipboard-Sync 拒絕發佈 copy 剪貼板
- 真實 Chrome：面板位於 `#folder-stats` 之後、進度條前進、速度顯示、完成後倒數消失

## 發佈

```js
exports.repo = "hugo529100/hfs-SafeMove"
```

GitHub repo 建議：

- repo 名稱：`hfs-SafeMove`（HFS 目錄會顯示為 `SafeMove`）
- 安裝內容放在 `dist/`
- topic：`hfs-plugin`
- `exports.apiRequired = 13.73` 已宣告

## 授權

與 HFS 相同，GPL-3.0。
