# taiko-liff-form-prod
【本番環境用】和太鼓サークルの出欠管理用LINE LIFFフォーム

## stagingの現在の動作

stagingフロントは現在、LINE IDトークンで認証した本人のメンバー情報と出欠情報を確認する読み取り専用モードです。通常起動では、staging Workerの`GET /line/home-summary`と`POST /line/attendance/all`だけを呼び出します。

初回登録、出欠登録・変更、メンバー編集、管理、フィードバック、GAS通信などの書き込み機能は停止しています。staging D1への初期データ同期、認証済み書き込みrouteの実装、書き込み権限テストが完了するまで開放しません。
