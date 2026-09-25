# Fast Page Chat 0.10.3 — GitHubベータ版

Chromeのサイドパネルにアプリ名と閉じるボタンが二重に出る問題を修正しました。ツールバーの拡張機能ボタンは、パネルが閉じていれば開き、開いていれば閉じます。Chrome標準の×も使えます。開くときの一時的なページアクセスは維持します。

OpenAI APIの初回設定では、モデルIDを毎回入力せずプルダウンから選べます。APIキーの保存後、OpenAIのモデル一覧から候補を取得できます。特殊なモデルIDは手入力できます。候補が表示されても、そのモデルの利用権限や回答対応は保証されません。モデル一覧取得では、補助アプリからOpenAIへAPIキーを送り、ページ本文・画像・会話は送りません。[プライバシーポリシー](https://ringoacid.github.io/fast-page-chat/privacy.html)にも追記しました。

Windows 11 HomeのVMで0.10.2から更新し、Chrome 154で重複表示の解消、アイコンの開閉、本文566文字の取得、保存済みAPI設定からのモデル候補取得を確認しました。単体テスト88件とブラウザ回帰が成功しています。利用者による0.10.2のAPI実回答報告と区別し、0.10.3では課金を伴う新しい回答を送っていません。詳しくは[検証記録](https://github.com/Ringoacid/fast-page-chat/blob/main/docs/validation-0.10.3.md)を参照してください。

## インストール・更新

1. `FastPageChat-0.10.3-windows-x64-Setup.exe` を実行します。既存の設定・履歴を保つため、拡張機能は削除しません。
2. Chromeの `chrome://extensions` でFast Page Chatを再読み込みします。初回は同梱の `%LOCALAPPDATA%\FastPageChat\app\extension` を読み込みます。
3. 通常のWebページでツールバーの拡張機能ボタンを押します。

別フォルダーに拡張機能を置いている場合は、同じ版の `fast-page-chat-0.10.3-extension.zip` でそのフォルダーを更新して再読み込みしてください。Chrome 142以降が必要です。Chrome Web Storeには未公開で、Windowsインストーラーは未署名です。配布元と `SHA256SUMS-0.10.3.txt` を確認してください。

API料金と各アカウントの利用制限が適用されます。不具合は[GitHub Issues](https://github.com/Ringoacid/fast-page-chat/issues)へ報告できます。キーや非公開のページ本文は投稿しないでください。
