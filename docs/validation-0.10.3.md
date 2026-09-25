# 0.10.3の検証記録

対象: 0.10.3。記録日: 2026-09-26。GitHubベータ版のUI修正を対象とする。

| 項目 | 結果 |
| --- | --- |
| 見出し・閉じるボタンの重複 | 拡張機能内の重複部分を除去。Chrome 154の実画面で、Chrome標準のアプリ名と閉じるボタンだけが残ることを確認。公開用スクリーンショットを更新。 |
| ツールバーの開閉 | Chrome標準の自動開閉を使わず、通常の拡張機能ボタン操作で開閉。Windows 11 Home VMで開く→閉じる→開くと、Chrome標準の×で閉じた後の再表示を確認。開いた後、公開ページの本文566文字を取得。 |
| APIモデル選択 | 初回設定をプルダウンに変更。保存済みAPIキーでOpenAIのモデル一覧を取得し、回答用候補をメニューに表示。VMで実際に複数の候補を確認。特殊なIDの手入力も維持。候補は利用権限やResponses API対応を保証しない。 |
| 設定の保護 | 0.10.2からのVM更新後もAPI設定ファイルが存在し、補助アプリ・拡張機能とも0.10.3。モデル一覧の要求はヘルパーからOpenAIへAPIキーだけを使用し、本文・画像・会話を含めない。モデルID以外を拡張機能へ返さない。 |
| API回答 | 利用者が0.10.2での実回答に問題がないと報告し、提供された画面にも回答が表示されている。0.10.3で課金を伴う新たな回答要求は行っていない。 |
| 単体・ブラウザ回帰 | 単体テスト88件、setup・browser・title-retryのブラウザ回帰が成功。モデル応答はモックであり、ツールバーの実操作は上のVM結果と区別する。 |
| Windows補助アプリ回帰 | 最終ビルドで14項目成功（`test-results/native-check-8EMOm6/result.json`）。実際のChromium Native Messaging、重複PATH環境、再インストール、一時APIキーの保護・復元を隔離データで確認。一時登録はテスト後に削除。 |

0.10.3はChrome 142以降を必要とする。Chromeの `sidePanel.close` と開閉通知を使うための下限で、VMではChrome 154で確認した。

最終ビルドのSHA-256: Setup.exe `05dac87e74c9732df838306aec24bf214aa10171927ab4d7ab4994987b386e10`、拡張機能ZIP `32806b5d38e276b8ffb992210fb6e72ba1503236014c77d4b7353ef7899b9f8e`、SHA256SUMS `59c4aa9f91d61915c082ab7886f11c3760a6aef78041deb4ebc02da9adff0c66`。最終ビルドのserver/extensionソース31ファイルは作業ツリーとSHA-256一致（配布時に公開用IDを挿入するmanifestを除く）。VMのUI実操作はこの最終ビルドより前の0.10.3候補で行い、最終ビルドではAPIモデル候補から旧モデルを除くフィルターのみ変更した。

[公開した0.10.3ベータ版](https://github.com/Ringoacid/fast-page-chat/releases/tag/v0.10.3)の3アセットはGitHubのSHA-256値と最終ビルドが一致する。公開対象104ファイルはレビュー済みのソース一覧とGitの内容が一致する。[Source checks](https://github.com/Ringoacid/fast-page-chat/actions/runs/36157666853)は公開元コミット `7330c4b048fb3b41197b9316e81c10b9735ffa92` で成功した。

[Pages公開](https://github.com/Ringoacid/fast-page-chat/actions/runs/36158015310)も成功した。公開ポリシーと `docs/privacy.html` のSHA-256はどちらも `883dd484f77dd80b593533dc2e7b9cbe6334ef7f0c9ea0941c68264ac50903a4` で一致する。同梱版 `extension/privacy.html` も同一内容。

画像の実送信、最終版の完全新規導入、途切れないWindows再起動、アンインストール後の削除、Chrome Web Storeの申告と審査は未完了。`docs/publication.json` の `cleanInstallVerified` はfalseのまま。0.10.2以前の証拠は[0.10.2の記録](validation-0.10.2.md)に残す。
