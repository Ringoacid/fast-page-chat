# Fast Page Chat 0.10.0 — GitHubベータ版

Chromeで開いているページを、そのまま翻訳・要約・質問できます。Codex App ServerとOpenAI APIに対応します。

今回の変更:

- Windows x64用の補助アプリにNode.jsとCodexを同梱。手動のサーバー起動と接続キーの転記を省きます。
- 初回画面で送信先と保存先を説明し、同意後にページを取得します。
- Codexログイン、API設定、接続診断と再接続を画面から行えます。
- APIキーはPC側でWindows DPAPIを使って保護します。
- 自動タイトル生成は初期状態で回答と同じ接続先・モデルを使用します。
- 全チャットとCodex診断データを、それぞれ設定から削除できます。
- 公開プライバシーポリシー、専用アイコン、MITライセンス、ソース検査とCIを追加しました。

## インストール

1. `FastPageChat-0.10.0-windows-x64-Setup.exe` を実行して、補助アプリをインストールします。
2. 完了画面の「拡張機能フォルダーを開く」で、同梱拡張機能の場所を確認します。
3. Chromeの `chrome://extensions` でデベロッパーモードを有効にし、`%LOCALAPPDATA%\FastPageChat\app\extension` を読み込みます。
4. 通常のページで拡張機能を開き、初回案内から接続・ログインします。

Chrome Web Storeには未公開のため、拡張機能の手動読み込みが必要です。Windowsインストーラーはコード署名されていません。配布元と添付のSHA256チェックサムを確認してください。Windowsの設定や組織ポリシーによって実行できない場合があります。

別フォルダーで拡張機能を管理する場合は、添付の `fast-page-chat-0.10.0-extension.zip` を展開して読み込むこともできます。

## 利用前に確認すること

- Codexはアカウントで利用可能なモデル・制限が適用されます。OpenAI APIはAPIキーと別途API利用料金が必要です。
- 質問時に本文・会話と、画像ON時の画像をOpenAIへ送信します。自動タイトルも追加送信します。[プライバシーポリシー](https://ringoacid.github.io/fast-page-chat/privacy.html)を確認してください。
- 0.9.xのソース版と配布ZIPでは拡張機能IDが異なる場合があります。履歴の自動移行はありません。必要な会話を書き出し、履歴が必要な旧版は削除しないでください。
- 開発環境のない別PCでの初回ログイン・実モデル回答は未検証です。検証範囲は[検証記録](https://github.com/Ringoacid/fast-page-chat/blob/main/docs/validation-0.10.0.md)に記載しています。

問題の報告は[GitHub Issues](https://github.com/Ringoacid/fast-page-chat/issues)へお願いします。APIキー、接続キー、非公開のページ本文は添付しないでください。
