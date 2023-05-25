let version = "0.0.20"

function poke(topic,body) {
	self.registration.showNotification(topic, {
		body: body,
		tag: 'webshareupload',
		badge: new URL("logo/96",self.registration.scope).toString(),
		icon: new URL("logo/192",self.registration.scope).toString(),
		silent: true,
	});
};

function uploadDone(req) {
	return req.then(function(response) {
		if (response.ok) {
			poke('Upload Completed');
		} else {
			poke('Upload Failed');
		}
		return true
	})
}

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
});

self.addEventListener('message', function(event){
	if (event.data == "debug") { poke("Test Notification",version); }
	if (event.data == "debug2") { self.registration.showNotification("Test2 Notification", {body: "Hope you are happy now",tag: 'egg',badge: new URL("logo/96",self.registration.scope).toString(),icon: new URL("logo/192",self.registration.scope).toString(),image: new URL("logo/main",self.registration.scope).toString(),vibrate: [500,110,500,110,450,110,200,110,170,40,450,110,200,110,170,40,500]}); }
});

self.addEventListener('fetch', function(event) {
	const url = new URL(event.request.url);
	if (event.request.method == 'POST' && url.pathname.endsWith('webshareupload')) {
		let req = fetch(event.request);
		event.respondWith(req);
		poke('Uploading File', 'Please wait while file is uploading');
		event.waitUntil(uploadDone(req));
	}
	return event.respondWith(fetch(event.request));
});
