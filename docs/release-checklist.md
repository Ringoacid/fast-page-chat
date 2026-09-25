# 公開前チェックリスト

対象: 0.10.0。未完了の項目を成功したものとして扱わない。

## 公開者が確定する項目

- [x] GitHubの所有者とリポジトリ名を確定する: `Ringoacid/fast-page-chat`。
- [x] 公開者名Ringoacid、通常サポートGitHub Issues、機密報告GitHub Private vulnerability reportingを指定する。
- [x] MIT Licenseを選択し、LICENSEへ反映する。
- [x] package.jsonのlicense欄をMITにし、GitHubでPrivate vulnerability reportingを有効にする。
- [x] `docs/publication.json` を実際の公開情報に更新する。
- [x] 同梱・公開ポリシーと公開サイトに確定した公開者・リンクを反映する。
- [x] ヘルパーの保存先・APIキーのDPAPI保護・Codex認証情報と診断記録・削除の実装をプライバシーポリシーと照合する。
- [ ] 実際の未設定PCでのインストール動作を確認する。
- [x] 第三者のNode.js・Codexバイナリを同梱する場合、配布する正確なバージョン、ライセンス、必要なNOTICEを含める。

## 公開URL

- [x] プライバシーポリシーをログイン不要のHTTPS URLで公開し、拡張機能同梱版と同じ内容であることを確認する。
- [x] GitHub Pagesを使う場合は、リポジトリのPages設定でGitHub Actionsを選び、ポリシーの確認後に手動のPublish Pagesワークフローを実行する。ソースのpushでは自動公開しない。ワークフローの `--policy` チェックはポリシー公開の準備を確認し、Web Store用の `--public` ゲートとは区別する。
- [ ] サポートURL・ポリシーURLをChrome Web Storeの掲載情報にも設定する。

## 初めて使う環境での確認

- [ ] Node.jsとCodexを未導入のWindowsアカウントで、インストールから最初の回答まで説明だけで進める。
- [ ] Windows再起動・ブラウザ再起動後に、ターミナル操作やキーの貼り付けなしで再接続できる。
- [ ] Codexのみ、APIのみの環境を別々に試す。回答と自動タイトルの両方が動く。
- [ ] 未ログイン・ログイン期限切れ・APIキー未設定・モデル利用不可の原因が設定画面で区別できる。
- [ ] 既存サーバーの停止、接続失敗、ポート競合、ヘルパー再起動から復旧できる。
- [ ] 前のバージョンから更新して、チャット・スキル・設定が保たれる。
- [ ] アンインストール後、残るデータと削除手順が案内と一致する。

## 実ブラウザでの確認

- [x] 配布予定の拡張機能IDでNative Messagingの接続を確認する（隔離Chromiumとテスト用ホスト登録）。
- [ ] ツールバーボタンによるサイドパネル開閉とactiveTabの権限付与を、実際のChromeで操作する。
- [ ] 全サイト・外部画像の権限を承認／拒否／撤回して確認する。
- [ ] 実際の画面撮影から切り出す画像、画面外画像、ページ移動中の中止を確認する。
- [ ] 複数ウィンドウ、キーボード操作、320px幅、ライト／ダークを確認する。
- [ ] 課金・利用制限を理解した検証用アカウントで、本文と画像の両接続先への実送信を試す。

## 自動チェックと配布物

- [x] `node --test test/*.test.mjs` が成功する（0.10.0確認時85件）。
- [x] setup、browser、title-retryのブラウザ回帰スクリプトの成功を確認する。モデル応答はモックであり、実モデル確認と区別する。[検証記録](validation-0.10.0.md)
- [x] `node scripts/check-release.mjs` が成功する。
- [x] `node scripts/prepare-source.mjs --dry-run` が成功する。
- [x] `node scripts/prepare-source.mjs` が生成したallowlist方式の出力だけを公開する。作業フォルダー全体を公開しない（96ファイルとGit登録内容のSHA-256一致を確認）。
- [x] `.env`、`.local`、`.research`、`test-results`、ブラウザプロファイル、認証情報が配布物にないことを確認する。
- [x] 専用アイコン、440×280のプロモーション画像、1280×800の実UIスクリーンショット、説明文、権限説明を確認する。
- [ ] Chrome Web Storeのデータ申告を実装・画面説明・ポリシーと照合する。「外部送信なし」「完全ローカル」と記載しない。
- [ ] すべての公開ゲートを満たしてから `node scripts/check-release.mjs --public` を実行する。

`policyFinalized`、`cleanInstallVerified`、`storeAssetsVerified` は証拠を確認してからtrueにする。自動チェックはストア審査合格、法令適合、秘密情報の完全な検出を保証するものではない。
