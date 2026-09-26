### 使用assrt.net在线获取srt字幕

- 运行

```shell
PORT=4000 https_proxy=http://127.0.0.1:20171 node main.js
```

- 请求请看: `http.http`

- 接口

  - `GET /search?q=关键词&page=页码`: 搜索字幕, `page` 可选, 缺省 `1`, 取 `1-100` 的整数(与上游末页一致), 非法值返回 `400 INVALID_PAGE`; 响应为结果数组
  - `GET /download/{id}.srt`: 下载字幕
