# taiko-liff-form-prod
【本番環境用】和太鼓サークルの出欠管理用LINE LIFFフォーム

## stagingの現在の動作

stagingフロントは現在、LINE IDトークンで認証した本人のデータをstaging D1から読み取り、本人向け予定と演奏者ごとの出欠状態をカード表示する読み取り専用モードです。通常起動では、staging Workerの`GET /line/home-summary`と`POST /line/attendance/all`だけを呼び出します。

各予定カードでは、Workerが`home-summary`で判定した予定単位・本人演奏者単位の回答可否を表示します。frontend側では受付条件を再実装しません。

`STAGING_AUTHENTICATED_READ_ONLY`を維持し、出欠状態と回答可否は表示だけとします。出欠入力・送信は未実装で、`POST /line/attendance/submit-authenticated`も呼び出しません。初回登録、出欠登録・変更、メンバー編集、管理、フィードバック、GAS通信などの書き込み機能は閉鎖しており、productionへも未反映です。
