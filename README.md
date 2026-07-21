# taiko-liff-form-prod
【本番環境用】和太鼓サークルの出欠管理用LINE LIFFフォーム

## stagingの現在の動作

stagingフロントは現在、LINE IDトークンで認証した本人のデータをstaging D1から読み取り、本人向け予定と演奏者ごとの出欠状態をカード表示する読み取り専用モードです。通常起動では、staging Workerの`GET /line/home-summary`と`POST /line/attendance/all`だけを呼び出します。

`STAGING_AUTHENTICATED_READ_ONLY`を維持し、出欠状態は表示だけとします。初回登録、出欠登録・変更、メンバー編集、管理、フィードバック、GAS通信などの書き込み機能は閉鎖しています。認証済み書き込みrouteの実装と書き込み権限テストが完了するまで開放せず、productionへも未反映です。
