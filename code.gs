var appToken = "xoxp-*****"

//コマンド受付＆キューイング命令＆削除開始メッセージ
function doPost(e) {
  var verificationToken = e.parameter.token;
  if (verificationToken != '**********') { // AppのVerification Tokenを入れる
    var response = {text: "Error: トークンが不正です！"};
    return ContentService.createTextOutput(JSON.stringify(response)).setMimeType(ContentService.MimeType.JSON);
  }
    
  var channel_id = e.parameter.channel_id
  var parameter = e.parameter.text;
  var param_array = parameter.split(/\s/)
    
  if(param_array.length != 2) {
    var response = {text: "SyntaxError: 引数は2つ指定してください！"};
    return ContentService.createTextOutput(JSON.stringify(response)).setMimeType(ContentService.MimeType.JSON);
  }
    
  var old = param_array[0].split(/\//)
  var late = param_array[1].split(/\//)
    
  if(old.length != 6 || late.length != 6) {
    var response = {text: "SyntaxError: 引数はYYYY/MM/DD/hh/mm/ssの形式で指定してください！"};
    return ContentService.createTextOutput(JSON.stringify(response)).setMimeType(ContentService.MimeType.JSON);
  }
    
  var oldest = Utilities.formatString("%s-%s-%sT%s:%s:%s+09:00", old[0], old[1], old[2], old[3], old[4], old[5])
  var latest = Utilities.formatString("%s-%s-%sT%s:%s:%s+09:00", late[0], late[1], late[2], late[3], late[4], late[5])
  oldest = Date.parse(oldest) / 1000 + ''
  latest = Date.parse(latest) / 1000 + ''
    
  if(isNaN(oldest) || isNaN(latest)) {
    var response = {text: "Error: タイムスタンプが生成できませんでした！引数はYYYY/MM/DD/hh/mm/ssの形式になっていますか？桁数、全角半角も確認してください！"};
    return ContentService.createTextOutput(JSON.stringify(response)).setMimeType(ContentService.MimeType.JSON);
  }
    
  //キューを追加
  addQueue(oldest, latest, channel_id);
    
  var response = {text: Utilities.formatString("チャンネル：%s のメッセージ削除を開始します！", e.parameter.channel_id)};
    
  //削除開始メッセージを送信
  return ContentService.createTextOutput(JSON.stringify(response)).setMimeType(ContentService.MimeType.JSON);
}

function addQueue(oldest, latest, channel_id){
  //引数をオブジェクトとしてまとめる
  var newQueue = {
    "oldest": oldest,
    "latest": latest,
    "channel_id": channel_id
  }
  
  cache = CacheService.getScriptCache();
  
  //キャッシュが残っている場合は削除
  if(cache.get("dates") != null){
    cache.remove("dates");
  }
    
  //キャッシュを登録
  cache.put("dates", JSON.stringify(newQueue)); 
    
  //1秒後に実行
  ScriptApp.newTrigger('executeDeletion').timeBased().after(1 * 1000).create();
  
  return;
}

//annihilateの呼び出し
function executeDeletion(){
  //cacheを取得
  cache = CacheService.getScriptCache();
  var data = cache.get("dates");
  
  //cacheの読み書きの競合が怖いのでなるべく早く消しておく
  cache.remove("dates");
  
  //TODO:cacheの中身がnullなら例外処理
  if(data==null){
    return;
  }
  
  //配列の中身をstrからJSON(object)に戻し，処理を実行する
  data = JSON.parse(data);
  annihilateMessages(data.oldest, data.latest, data.channel_id);
  return;
}

//メッセージ削除のメイン処理関数
function annihilateMessages(oldest, latest, channel_id) {
  //使用済みのトリガーを削除
  deleteTriggers();
    
  var response = collectHistory(oldest, latest, channel_id)
  var parsed = JSON.parse(response)
  var count = parsed.messages.length
    
  postMessage(channel_id, Utilities.formatString("%s件削除します！", count))
    
  for(var i = 0; i < Math.floor(count / 30) + 1; i++) {
    var requests = []
    
    //一度にfetchする件数をカウントするための変数
    var num = 0
        
    for(var j = 0; j < 30; j++){
      //残り30件を下回った場合、インデックスエラーを起こさないための処理
      if(j >= count - 30 * i) {
        break
      }
          
      var timestamp = parsed.messages[j + i * 30].ts;
            
      var payload = {
        "token": appToken,
        "channel" : channel_id,
        "ts": timestamp
      }
            
      var request = {
        "url": "https://slack.com/api/chat.delete",
        "method": "post",
        "payload": payload
      }
            
      requests.push(request);
      num += 1;
            

            //300件以上ある時は途中経過をキャッシュして中断＆自動再開
            if(parsed.has_more == true && 30 * i + j == 299){
                addQueue(oldest, timestamp, channel_id);
                postMessage(channel_id, "annihilateの実行時間がまもなく6分を越えるため、途中経過をキャッシュします！中断した処理は自動的に再開されます！");
            }
        }
        
    var responses = UrlFetchApp.fetchAll(requests);
        
    //TooManyRequestsException用例外処理
    responses.forEach(function(r) {
      if(r.getResponseCode() == 429) {
        var text = Utilities.formatString("rate limitを超過しました。%s件削除しましたが、%s件はスキップされます。", 30 * i, count - 30 * i);
        postMessage(channel_id, text);
        return
      }
    })
        
    //最終ラウンド（has_more: falseかつi == Math.floor(count / 30)）以外は、rate limit対策のため（1.2 * num）秒スリープ
    if(parsed.has_more == true || i != Math.floor(count / 30)){
      Utilities.sleep(1200 * num);
    }
  }
    
  postMessage(channel_id, Utilities.formatString("%s件削除しました！", count))
}

//削除対象となるメッセージのリストを取得
//countパラメータは1000がMAX
function collectHistory(oldest, latest, channel_id) {
  var payload = {
    "token" : appToken,
    "channel" : channel_id,
    "count" : 300,
    "inclusive": true,
    "latest": latest,
    "oldest": oldest
  }

  var options = {
    "method" : "GET",
    "payload" : payload
  }


    var response = UrlFetchApp.fetch("https://slack.com/api/conversations.history", options);
    return response;
}

//annihilate実行時に前回作成されたトリガーを削除
function deleteTriggers() {
  var triggers = ScriptApp.getProjectTriggers();
  for(var i=0; i < triggers.length; i++) {
    ScriptApp.deleteTrigger(triggers[i]);
  }
}

//チャンネルへのメッセージ投稿
function postMessage(channel_id, text) {
  var payload = {
    "token" : appToken,
    "channel" : channel_id,
    "text": text
  }
    
  var options = {
    "method" : "POST",
    "payload" : payload
  }
    
  UrlFetchApp.fetch("https://slack.com/api/chat.postMessage", options);
}

//アプリケーションの公開確認用関数
function doGet(e) {
  var channel = channel_id
  var text = "アプリケーションは公開されています。"
    
  postMessage(channel, text);
}
