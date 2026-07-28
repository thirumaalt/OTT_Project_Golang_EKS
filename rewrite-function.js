function handler(event) {
    var request = event.request;
    request.uri = request.uri.replace(/^\/api\/media\/hls\//, '/hls/');
    return request;
}