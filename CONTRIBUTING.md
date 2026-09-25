# 開発と検証

公開リポジトリは [Ringoacid/fast-page-chat](https://github.com/Ringoacid/fast-page-chat) です。ソースコードは [MIT License](LICENSE) で提供します。通常の提案や不具合報告にはGitHub Issuesを使用し、秘密情報は含めないでください。

## 基本チェック

Node.js 22.9以降を使用します。単体テストとソース梱包の検査に外部npmパッケージは不要です。

```powershell
node --test test/*.test.mjs
node scripts/check-release.mjs
node scripts/prepare-source.mjs --dry-run
```

単体テストはモデル応答をモックに置き換え、実際のOpenAI要求や課金を発生させません。GitHub Actionsもこの範囲を実行します。Node.jsの対応範囲を変更した場合はCIのマトリクスを更新します。

## ブラウザ回帰チェック

Playwright 1.62.1と、それに対応するChromiumを使用します。`npm ci`、`npx playwright install chromium` でpackage-lock.jsonの固定依存とブラウザを導入してください。外部環境を使う場合は `PLAYWRIGHT_MODULE` に同バージョンのPlaywrightの `index.mjs`、`CHROMIUM_BIN` に対応するChromium実行ファイルを指定します。

```powershell
node scripts/extraction-boundary-check.mjs
node scripts/setup-check.mjs
node scripts/browser-check.mjs
node scripts/title-retry-check.mjs
```

これらは隔離プロファイルとローカルの人工ページを使い、モデル応答をモックに置き換えます。出力は `test-results/` に保存します。スクリプト間で出力パスが重なるため同時に実行しないでください。利用者のブラウザプロファイルを指定しないでください。

サイドパネルの通常タブでの表示や、権限確認・activeTab選択・画面撮影の一部差し替えがあるため、実際のツールバーボタン、権限ダイアログ、Native Messaging、最初の回答までの導入を別途確認します。チェック項目は [公開前チェックリスト](docs/release-checklist.md) にあります。

`zenn-image-check.mjs`、`zenn-note-content-check.mjs`、`reddit-content-check.mjs` は実サイトへアクセスします。通常CIでは実行せず、相手サイトの変更やアクセス制限による結果はローカルの回帰テストと区別してください。

## Windowsヘルパーのビルド

Windows x64と.NET FrameworkのC#コンパイラーがあるビルド環境で実行します。初回は、固定したNode.js・Codexの配布アーカイブを取得するためにネットワーク接続が必要です。

```powershell
powershell -File scripts/build-windows.ps1
```

`installer/runtime-lock.json` に記載したURLからランタイムを取得し、固定したSHA-256と一致することを確認してから展開します。ダウンロード済みアーカイブは `.build-cache/` に保存します。オフラインで既存キャッシュだけを利用する場合は `-SkipDownload` を付けます。この場合もハッシュを確認し、必要なアーカイブがなければ失敗します。

ビルドは、Node.js・Codexの実行ファイル、サーバー、拡張機能、必要なライセンス通知をまとめ、C#のNative Messagingランチャーとインストーラーをコンパイルします。開発用の `extension/manifest.json` は変更せず、配布する拡張機能にだけ固定ID用の公開鍵を加えます。

`dist/` に次のファイルを生成します。ファイル名のバージョンはpackage.jsonに従います。

- `FastPageChat-0.10.0-windows-x64-Setup.exe`
- `fast-page-chat-0.10.0-extension.zip`
- `SHA256SUMS-0.10.0.txt`
- 検証用の `windows-<build-id>/` フォルダー

このビルド手順はコード署名を行いません。現在のSetup.exeは未署名であり、Windowsで実行時の確認や警告が表示される場合があります。配布するファイルのハッシュ・同梱通知・動作を確認し、未署名であることを配布案内にも明記します。ランタイムのSHA-256検査は、Setup.exeのコード署名の代わりではありません。

## Windowsのネイティブ接続チェック

ビルド完了時に表示される `Staging retained for verification` のフォルダーから、`app` を指定します。`<build-id>` は実際に生成されたフォルダー名へ置き換えてください。

```powershell
node scripts/native-check.mjs --app "dist/windows-<build-id>/app"
```

このチェックは `test-results/` 内に検証専用のインストール先とデータフォルダーを作り、インストーラーを `-NoRegister` で実行します。製品用のChrome登録や利用者の認証情報を変更せず、コンパイル済みランチャー、同梱Node.js、接続サーバー、同梱Codex、Windows DPAPIを通して検証します。接続元の拒否、通信フレームの検証、サーバーの起動・再利用・終了・再起動、設定の保持を確認します。

`--browser` を加えると、Playwrightの隔離Chromiumプロファイルと配布IDを持つテスト用拡張から、実際のNative Messagingも確認します。このオプションだけはランダム名のテスト用ホストをHKCUに一時登録し、終了時に削除します。既存の製品用登録は変更しません。ブラウザ依存の準備と環境変数は前述のブラウザ回帰チェックと同じです。

検証用のAPI設定値はOpenAIへ送らず、Codexは未ログイン状態を確認します。利用者の実ログインと実モデルへの送信は行いません。成功しても、Node.js・Codexが未導入のPCでSetup.exeから最初の回答まで進める確認を済ませたことにはなりません。実施済みの範囲は [0.10.0の検証記録](docs/validation-0.10.0.md) を参照してください。

## 変更時の確認

- 新機能の取得・保存・送信データが変わる場合は、同梱と公開サイト両方のプライバシーポリシー、画面の説明、ストア申告を更新します。
- 不具合修正では実際に起きる失敗と回復を検証します。実モデルを使う検証は、モックでの成功と区別して記録します。
- Node.jsやCodexの同梱バージョンを変更する場合は、配布物のチェックサムとライセンスを確認し、初回導入を再検証します。
- `.env`、`.local`、認証情報、個人のページ本文・画像、ブラウザプロファイルはコミットしません。

## ソースの配布

```powershell
node scripts/prepare-source.mjs
```

`dist/` 内に明示した許可リストだけをコピーし、ファイル一覧とSHA-256を `SOURCE-MANIFEST.json` に書き出します。同名の出力が存在する場合は上書きしません。出力先を変える場合は `--out dist/任意の新しい名前` を指定します。これはGitHubへの公開やリポジトリ作成を行うコマンドではありません。

文字列検査は、既知形式のキーや秘密鍵を見つけるための補助です。完全な秘密検出ではないため、生成したファイル一覧をレビューし、GitHubへの初回公開ではこの出力だけを使用してください。
