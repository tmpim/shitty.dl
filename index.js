const package = require("./package.json");
const version = package.version;
const userConfig = require(process.argv[2] || "./config.json");

const _ = require("lodash");

if (!userConfig.sessionSecret) {
	console.error("Configuration error: Please put a secure random value in config.sessionSecret");
	process.exit(0);
}

const requiredConfig = ["password","imagePath","url","listen"]
_.forEach(requiredConfig, (key)=>{
	if (!userConfig[key]) {
		console.error("Configuration error: Please put a proper "+key+" value in config."+key);
		process.exit(0);
	}
})

if (typeof userConfig.password === "string") {
	userConfig.password = [userConfig.password];
}

if (typeof userConfig.logo === "string") {
	userConfig.logo = {"main": userConfig.logo};
}

for (const host in (userConfig.otherHosts || {})) {
	const hostCfg = userConfig.otherHosts[host];

	if (typeof hostCfg.password === "string") {
		hostCfg.password = [hostCfg.password];
	}

	if (typeof hostCfg.logo === "string") {
		hostCfg.logo = {"main": hostCfg.logo};
	}
}

for (const password of _.concat(userConfig.password, _.map(userConfig.otherHosts, "password").filter(x => !!x))) {
	if (!password.match(/^[0-9a-f]{64}$/i)) {
		console.error("Password does not look like an sha256 hash. Read the damn docs");
		process.exit(0);
	}
}

const fallbackConfig = {
	"logo": {
		"main": "poop.png",
		"px32": "poop32.png",
		"px96": "poop96.png",
		"px192": "poop192.png",
		"px512": "poop512.png"
	},
	"name": "shitty.download",
	"app_name": "Shitty",
	"name_color": "#a5673f",
	"background_color": "#dadada",
	"title": "Shitty.dl file host lies here",
	"disclaimer": "for dmca etc., contact domain owner.",
	"fileLength": 4,
	"pasteThemePath": "https://atom.github.io/highlights/examples/atom-dark.css",
	"oldPasteThemeCompatibility": true,
	"uploadDeleteLink": true,
	"rawPasteAgents": "^(?:computercraft|curl|wget)",
	"otherHosts": {}
}

const config = _.merge(
  {},
  fallbackConfig,
  userConfig
)

config.imageFiles = config.imageFiles || ["jpeg","jpg","png","gif"];
config.audioFiles = config.audioFiles || ["mp3","wav","flac","ogg"];
config.videoFiles = config.videoFiles || ["mp4","webm"];
config.languagePackages = config.languagePackages || [];
config.url = config.url.replace(/\/?$/, "/");
config.imagePath = config.imagePath.replace(/\/?$/, "/");
const rawPasteAgentsRegExp = config.rawPasteAgents ? new RegExp(config.rawPasteAgents, "i") : null;
const maxPasteSize = 2 ** 19;
const maxUrlSize = 1024;

const fs = require("fs");
const path = require("path");
const url = require("url");
const util = require("util");

const express = require("express");
const router = express.Router();
const bb = require("express-busboy");
const handlebars = require("express-handlebars");
const promBundle = require("express-prom-bundle");
const session = require("express-session");
const FileStore = require('session-file-store')(session);
const helpers = require("handlebars-helpers")();
const dateformat = require("helper-dateformat");
const Finder = require("fs-finder");
const moment = require("moment");
const openidClient = require("openid-client");

const paginator = new require("paginator")(48, 8);
const crypto = require("crypto");
const sanitizeFilename = require("sanitize-filename");
const CodeRain = require("coderain");
const cr = new CodeRain(("#").repeat(config.fileLength || 4));
const crNonce = new CodeRain(("#").repeat(30));
const filesize = require("filesize");

const readChunk = require('read-chunk');
const fileType = require('file-type');

let Highlights, highlighter;

try {
    Highlights = require("highlights");
    highlighter = new Highlights({scopePrefix: config.oldPasteThemeCompatibility ? "" : "syntax--"});
} catch (e) {
	Highlights = null;
	highligher = null;
	console.error("Unable to find `highlights` package. If you require syntax highlighting, please install it.");
	console.error("If your system is incompatible with `highlights`, feel free to ignore this.");
}

const app = express();

const imageFilesFilter = _.map(config.imageFiles,(v)=>"."+v).join(",");
const audioFilesFilter = _.map(config.audioFiles,(v)=>"."+v).join(",");
const videoFilesFilter = _.map(config.videoFiles,(v)=>"."+v).join(",");
const galleryMask = "*.<("+config.imageFiles.concat(config.audioFiles,config.videoFiles).join("|")+")$>";
  
let nonces = {};
let noncesLookup = {};

let statCache = {version};

let customName;
if (fs.existsSync("custom-name.js")) {
	customName = require("./custom-name.js");
}

let oidcClient;
(async() => {
  const oidcIssuer = config.oidcUrl && await openidClient.Issuer.discover(config.oidcUrl);
  oidcClient = new oidcIssuer.Client({
    client_id: config.oidcClientId,
    client_secret: config.oidcClientSecret,
    redirect_uris: [config.url + "oidc/callback"],
    response_types: ["code"],
    token_endpoint_auth_method: "client_secret_post",
  });
})()
const oidcStateMap = new Map();

if (fs.existsSync("stats.json")) {
	try {
		statCache = JSON.parse(fs.readFileSync("stats.json"));
	} catch(error) { console.error('stats.json file was corrupted and has been regenerated. Please merge your backup with current one.'); statCache = {version}; }

	if (statCache.version !== version) statCache = { version }; /* note: remember to change version every time stats.json format changes */
	else {
		_.forOwn(statCache, (value, key) => {
			if ( key === "version" ) return;
			value.mtime = new Date(value.mtimeSave);
		});
	}
}

if (fs.existsSync("nonces.json")) {
	try {
		nonces = JSON.parse(fs.readFileSync("nonces.json"));
	} catch(error) { console.error('nonces.json file was corrupted and has been regenerated. Please merge your backup with current one.'); nonces = {}; }

	_.forOwn(nonces, (value, key) => {
		noncesLookup[nonces[key]] = key;
	});
}

const pathname = new url.URL(config.url).pathname.replace(/\/?$/, "/");

if (highlighter && config.languagePackages) {
  config.languagePackages.forEach(package => {
    try {
      const pkg = require.resolve(`${package}/package.json`);
      highlighter.requireGrammarsSync({ modulePath: pkg });
    } catch (e) {
      console.warn(`Could not find/load language package ${package}`)
    }
  });
}

const imagePaths =
	_(config.otherHosts).values()
		.map("imagePath").filter(x => !!x)
		.concat(config.imagePath)
		.value();

for (imagePath of imagePaths) {
	if (!fs.existsSync(`${imagePath}/.deleted`)){
		fs.mkdirSync(`${imagePath}/.deleted`);
	}
}

// fs.writeFileSync("public/manifest.json", JSON.stringify());
function genManifest(hostConfig) {
	return {
		"short_name": hostConfig.app_name,
		"name": hostConfig.name,
		"share_target": {
		  "action": "webshareupload",
		  "method": "POST",
		  "enctype": "multipart/form-data",
		  "params": {
			"title": "sharetitle",
			"text": "sharetext",
			"url": "shareurl",
			"files": [
			  {
				"name": "file",
				"accept": ["*/*"]
			  }
			]
		  }
		},
		"description": hostConfig.title,
		"icons": [
		  {
			"src": "logo/96",
			"sizes": "96x96",
			"type": "image/png"
		  },
		  {
			"src": "logo/192",
			"sizes": "192x192",
			"type": "image/png"
		  },
		  {
			"src": "logo/512",
			"sizes": "512x512",
			"type": "image/png"
		  }
		],
		"start_url": "webshareupload",
		"scope": "webshareupload",
		"display": "standalone",
		"theme_color": hostConfig.name_color,
		"background_color": hostConfig.background_color
	}
}

app.engine(".hbs", handlebars({
	defaultLayout: "main",
	extname: ".hbs",
	helpers: _.merge(helpers, {
		"dateformat" : dateformat,
		section: function(name, options){
			if(!this._sections) this._sections = {};
			this._sections[name] = options.fn(this);
			return null;
		},
		base64: data => Buffer.from(data).toString("base64"),
		lessThan: function (v1, v2, options) {
		  if (v1<v2) return options.fn(this);
		  return options.inverse(this);
		}
	})
}));
app.set("view engine", ".hbs");
app.use(session({
	secret: config.sessionSecret,
	cookie: {maxAge: 2*31*24*60*60*1000},
	store: new FileStore({}),
	resave: false,
	saveUninitialized: false
}));
app.set("trust proxy", ["loopback", "linklocal", "uniquelocal"]);

bb.extend(app, {
	upload: true
});

function error(req, res, error) {
	const conf = req.config;
	console.error(util.inspect(error, {
		depth: null,
		colors: true,
		showHidden: true
	}));

	if (req.xhr || req.headers.accept.indexOf('json') > -1) {
		res.json({ ok: false, error });
	} else {
		res.render("error", {
			name: conf.name,
			background_color: conf.background_color,
			errorText: error,
			pathname
		});
	}
}

function success(req, res, success) {
	const conf = req.config;
	if (req.xhr || req.headers.accept.indexOf('json') > -1) {
		res.json({ ok: true, success });
	} else {
		res.render("success", {
			name: conf.name,
			background_color: conf.background_color,
			successText: success,
			pathname
		});
	}
}

function moveFile(oldPath, newPath, callback) {
	fs.rename(oldPath, newPath, err => {
		if (err) {
			if (err.code === "EXDEV") {
				copy();
			} else {
				callback(err);
			}

			return;
		}

		callback();
	});

	function copy() {
		const readStream = fs.createReadStream(oldPath);
		const writeStream = fs.createWriteStream(newPath);

		readStream.on("error", callback);
		writeStream.on("error", callback);

		readStream.on("close", () => fs.unlink(oldPath, callback));

		readStream.pipe(writeStream);
	}
}

function generateNonce(filePath) {
	let nonce;
	let attempts = 0;
	do {
		nonce = crNonce.next();
		attempts++;

		if (attempts > 20) {
			return "CouldNotGenerateUniqueNonceAfter20Attempts.";
		}
	} while (nonces[nonce]);
	nonces[filePath] = nonce;
	noncesLookup[nonce] = filePath;
	return nonce;
}

function removeNonce(nonce) {
	delete statCache[noncesLookup[nonce]];
	delete nonces[noncesLookup[nonce]];
	delete noncesLookup[nonce];
	fs.writeFile("nonces.json", JSON.stringify(nonces), () => {});
	fs.writeFile("stats.json", JSON.stringify(statCache), () => {});
}

function flushStats() {
	fs.writeFile("stats.json", JSON.stringify(statCache), () => {});
}

function flushNonces() {
	fs.writeFile("nonces.json", JSON.stringify(nonces), () => {});
}

function checkPassword(conf, password) {
	const passwordHash = crypto.createHash("sha256").update(password).digest("hex");
	return conf.password.includes(passwordHash);
}

/*app.use(promBundle({
	includeMethod: true,
	includePath: true,
	normalizePath: req => {
		return url.parse(req.originalUrl).pathname;
	}
}));*/

function auth(req, res, next) {
	if (!req.session || !req.session.authed) {
		return res.redirect(pathname);
	}

	next();
}

router.use(express.static("public"));
for (const imagePath of imagePaths) {
	router.use(express.static(imagePath));
}

router.use(function selectConfig(req, res, next) {
	const newConfigVals = config.otherHosts[req.hostname];
	if (!newConfigVals)  {
		req.config = config;
	} else {
		req.config = _.merge({}, config, {url: `https://${req.hostname}/`}, newConfigVals);
	}

	next();
});

router.get("/logo/main", (req, res) => {res.sendFile(req.config.logo.main ,{ root : "public"});});
router.get("/logo/32", (req, res) => {res.sendFile(req.config.logo.px32 ,{ root : "public"});});
router.get("/logo/96", (req, res) => {res.sendFile(req.config.logo.px96 ,{ root : "public"});});
router.get("/logo/192", (req, res) => {res.sendFile(req.config.logo.px192 ,{ root : "public"});});
router.get("/logo/512", (req, res) => {res.sendFile(req.config.logo.px512 ,{ root : "public"});});

router.get("/manifest.json", (req, res) => {res.send(genManifest(req.config));});

router.get(["/", "/home"], (req, res) => {
	const conf = req.config;
	res.render("home", {
		name: conf.name,
		name_color: conf.name_color,
		background_color: conf.background_color,
		title: conf.title,
		disclaimer: conf.disclaimer,
		authed: req.session && req.session.authed,
		pathname,
    oidc: !!oidcClient,
    oidcProviderName: conf.oidcProviderName
	});
});

router.get("/login", (req, res) => {res.redirect(pathname+"home");});
router.post("/login", (req, res) => {
	if (!req.body.password) return error(req, res, "No password specified.");
	if (!checkPassword(req.config, req.body.password)) return error(req, res, "Incorrect password.");

	req.session.authed = true;
	req.session.save();

	res.redirect(pathname+"gallery");
});

router.get("/oidc/redirect", (req, res) => {
  if (!oidcClient) return error(req, res, "OIDC not configured");
  const state = crypto.randomBytes(8).toString("hex");
  oidcStateMap.set(req.ip, state);
	console.log(req.ip)
  res.redirect(oidcClient.authorizationUrl({
    scope: config.oidcScopes,
    state
  }));
})

router.get("/oidc/callback", async (req, res) => {
  if (!oidcClient) return error(req, res, "OIDC not configured");

  try {
    const params = oidcClient.callbackParams(req.url);
    await oidcClient.callback(config.url + "/oidc/callback", params, {
      state: oidcStateMap.get(req.ip)
    });

    req.session.authed = true;
    req.session.save();
  
    res.redirect(pathname+"gallery");
  } catch(e) {
    return error(req, res, "OIDC authentication failed");
  }
})

router.get(["/upload","/webshareupload"], auth, (req, res) => {
	const conf = req.config;
	res.render("upload", {
		name: conf.name,
		name_color: conf.name_color,
		background_color: conf.background_color,
		pageTemplate: "upload",
		pathname
	});
});

router.post(["/upload","/webshareupload"], (req, res) => {
	const conf = req.config;

	if ( typeof req.body.link === "undefined" && typeof req.body.file === "undefined" && (!req.files || !req.files.file)) return error(req, res, "No file/URL specified.");

	if (!req.session || !req.session.authed) {
		if (!req.body.password) return error(req, res, "No password specified.");
		if (!checkPassword(conf, req.body.password)) return error(req, res, "Incorrect password.");
	}

	let file;
	if (req.body.file) {
		file = Buffer.from(req.body.file , 'base64');
	}

	let ext = "";
	if (req.body.link) ext = "";
	else if (req.query.ext) ext = sanitizeFilename(req.query.ext);
	else if (file) {
		const exten = fileType(file);
		if (exten) ext = "." + exten.ext;
	}
	else if (path.extname(req.files.file.filename) !== "") {ext = path.extname(req.files.file.filename)}
	else {
		const exten = fileType(readChunk.sync(req.files.file.file , 0, 4100));
		if (exten) ext = "." + exten.ext;
	}

	// if (ext.toLowerCase() === ".php") return error(req, res, "Disallowed file type.");

	let name;
	let attempts = 0;

	do {
		if (attempts === 0 && req.body.name && req.body.name.length > 0) {
			name = req.body.name.replace(/[^A-Za-z0-9_\-]/g, "_");
		} else {
			if (customName) {
				name = customName(req.host, req.config);
			} else {
				name = cr.next();
			}
		}

		attempts++;

		if (attempts > 20) {
			return error(req, res, "Could not generate unique filename after 20 attempts.");
		}
	} while (fs.existsSync(`${conf.imagePath}/${name}${ext}`));

	if (req.body.link) {
		fs.writeFile(`${conf.imagePath}/${name}`, req.body.link, (err) => {
			if (err) {
					   error(req, res, "Upload failed.");
					   return console.log(JSON.stringify(err));
			}
			let nonce = generateNonce(`${conf.imagePath}/${name}`);
			flushNonces();
			name = "l/" + name;

			if (req.path === "/webshareupload") {
				success(req, res, `URL shortened to <a href="${conf.url}${name}">"${conf.url}${name}"</a>` );
			} else {
				res.json({
					ok: true,
					url: `${conf.url}${name}`,
					deleteUrl: conf.uploadDeleteLink ? `${conf.url}delete/${nonce}` : undefined
				});
			}
		});
	} else if (file) {
		fs.writeFile(`${conf.imagePath}/${name}${ext}`, file, (err) => {
			if (err) {
					   error(req, res, "Upload failed.");
					   return console.log(JSON.stringify(err));
			}
			let nonce = generateNonce(`${conf.imagePath}/${name}${ext}`);
			flushNonces();

			if (req.path === "/webshareupload") {
				success(req, res, `${conf.url}${name}${ext}` );
			} else if (req.body.online === "yes") {
				res.redirect(`${conf.url}${name}${ext}`);
			} else {
				res.json({
					ok: true,
					url: `${conf.url}${name}${ext}`,
					deleteUrl: conf.uploadDeleteLink ? `${conf.url}delete/${nonce}` : undefined
				});
			}
		});
	} else {
		moveFile(req.files.file.file, `${conf.imagePath}/${name}${ext}`, err => {
			if (err) {
					   error(req, res, "Upload failed.");
					   return console.log(JSON.stringify(err));
			}
			let nonce = generateNonce(`${conf.imagePath}/${name}${ext}`);
			flushNonces();

			if (typeof req.query.paste !== "undefined") {
				name = "paste/" + name;
			}

			if (req.path === "/webshareupload") {
				success(req, res, `${conf.url}${name}${ext}` );
			} else if (req.body.online === "yes") {
				res.redirect(`${conf.url}${name}${ext}`);
			} else {
				res.json({
					ok: true,
					url: `${conf.url}${name}${ext}`,
					deleteUrl: conf.uploadDeleteLink ? `${conf.url}delete/${nonce}` : undefined
				});
			}
		});
	}
});

router.all("/delete/:nonce", (req, res) => {
	const conf = req.config;

	if (typeof req.params.nonce === "undefined" || typeof noncesLookup[req.params.nonce] === "undefined") return error(req, res, "Invalid nonce provided");

	if (!conf.uploadDeleteLink && ( !req.session || !req.session.authed ) ) {
		if (!req.body.password) return error(req, res, "No password specified.");
		if (!checkPassword(conf, req.body.password)) return error(req, res, "Incorrect password.");
	}

	const filePath = noncesLookup[req.params.nonce];
	const fileName = path.basename(filePath);

	if (!fs.existsSync(filePath)) return error(req, res, "File don't exist");

	moveFile( filePath , `${conf.imagePath}/.deleted/${fileName}`, err => {
		if (err) {error(req, res, "Deletion Failed."); return console.log(JSON.stringify(err));}
		success(req, res, `File ${fileName} deleted successfuly`);
		removeNonce(req.params.nonce)
	});
});

router.post("/rename", (req, res) => {
	const conf = req.config;

	if (typeof req.body.nonce === "undefined" || typeof req.body.name === "undefined" || typeof noncesLookup[req.body.nonce] === "undefined") return error(req, res, "No file specified.");

	if (!req.session || !req.session.authed) {
		if (!req.body.password) return error(req, res, "No password specified.");
		if (!checkPassword(conf, req.body.password)) return error(req, res, "Incorrect password.");
	}

	const filePath = noncesLookup[req.body.nonce];
	const fileName = path.basename(filePath);
	const name = sanitizeFilename(req.body.name);

	if (!fs.existsSync(filePath)) return error(req, res, "File don't exist");
	if (fs.existsSync(`${conf.imagePath}/${name}`)) return error(req, res, "Filename already in use.");
	// if (path.extname(name).toLowerCase() === ".php") return error(req, res, "Disallowed file type.");

	moveFile( filePath , `${conf.imagePath}/${name}`, err => {
		if (err) {error(req, res, "Rename Failed."); return console.log(JSON.stringify(err));}
		success(req, res, `File ${fileName} renamed to ${name} successfuly`);
		removeNonce(req.body.nonce)
	});
});

router.post("/edit", (req, res) => {
	const conf = req.config;

	if (typeof req.body.nonce === "undefined" || typeof req.body.file === "undefined" || typeof noncesLookup[req.body.nonce] === "undefined") return error(req, res, "No file specified.");

	if (!req.session || !req.session.authed) {
		if (!req.body.password) return error(req, res, "No password specified.");
		if (!checkPassword(conf, req.body.password)) return error(req, res, "Incorrect password.");
	}

	const filePath = noncesLookup[req.body.nonce];
	const fileName = path.basename(filePath);
	const fileContents = Buffer.from(req.body.file , 'base64');

	if (!fs.existsSync(filePath)) return error(req, res, "File don't exist");

	fs.writeFile(`${filePath}`, fileContents, (err) => {
		if (err) {
      error(req, res, "Edit failed.");
			return console.log(JSON.stringify(err));
		}
		
		delete statCache[filePath]; //Invalidate stats for file on edit.
		flushStats()

		success(req, res, `File ${fileName} edited successfuly`);
	});
});

function shouldReturnRaw(req) {
	return rawPasteAgentsRegExp && rawPasteAgentsRegExp.test(req.headers["user-agent"]);
}

router.get("/paste/:file", (req, res) => {
	const conf = req.config;

	if (shouldReturnRaw(req)) return res.redirect("/" + req.params.file);

	const filename = sanitizeFilename(req.params.file);
	const filePath = path.join(conf.imagePath, filename);

	if (!filePath) return res.status(404).send("File not found");

	try {
		if (!fs.existsSync(filePath))  return res.status(404).send("File not found");
		const stats = fs.statSync(filePath);

		//console.log(stats);

		if (!stats.isFile()) return res.status(404).send("File not found");
		if (stats.size > maxPasteSize) return error(req, res, `File too large (${filesize(stats.size)})`);

		const html = highlighter
			? highlighter.highlightSync({filePath})
			: "<pre class='editor'>" + _.escape(fs.readFileSync(filePath).toString()) + "</pre>";

		res.render("paste", {
			paste: html,
			style: conf.pasteThemePath || "https://atom.github.io/highlights/examples/atom-dark.css",
			name: filename,
			pathname,
			layout: false
		});
	} catch (err) {
		error(req, res, err);
	}
});

router.get("/edit/:file", (req, res) => {
	const conf = req.config;

	if (shouldReturnRaw(req)) return res.redirect("/" + req.params.file);

	let editor = true;
	if (!req.session || !req.session.authed) {
		if (!req.body.password) editor = undefined;
		else if (!checkPassword(conf, req.body.password)) return error(req, res, "Incorrect password.");
	}

	const filename = sanitizeFilename(req.params.file);
	const filePath = path.join(conf.imagePath, filename);

	if (!filePath) return res.status(404).send("File not found");

	try {
		if (!fs.existsSync(filePath)) return res.status(404).send("File not found");
		const stats = fs.statSync(filePath);

		//console.log(stats);

		if (!stats.isFile()) return res.status(404).send("File not found");
		if (stats.size > maxPasteSize) return error(req, res, `File too large (${filesize(stats.size)})`);

		const filecontents = fs.readFileSync(filePath, { encoding: "utf8" });

		res.render("edit", {
			filecontents,
			name: filename,
			nonce: nonces[filePath],
			editor,
			pathname,
			layout: false
		});
	} catch (err) {
		error(req, res, err);
	}
});

router.get("/l/:file", (req, res) => {
	const conf = req.config;
	const filename = sanitizeFilename(req.params.file);
	const filePath = path.join(conf.imagePath, filename);

	if (!filePath) return res.status(404).send("File not found");
	if (path.extname(filePath)) return error(req, res, "URL not valid");

	try {
		if (!fs.existsSync(filePath))  return res.status(404).send("File not found");
		const stats = fs.statSync(filePath);

		if (!stats.isFile()) return res.status(404).send("File not found");
		if (stats.size > maxUrlSize) return error(req, res, `URL too large (${filesize(stats.size)})`);

		res.redirect(fs.readFileSync(filePath, { encoding: "utf8" }).trim());
	} catch (err) {
		error(req, res, err);
	}
});

function fileListing(mask, pageTemplate, route, req, res) {
	const conf = req.config;
	if (req.query.search) {
		mask = conf.imagePath.slice(0,-1)+`*<(${req.query.search.split(",").join("|").replace(/[a-zA-Z]/g, x => {return '['+x.toLowerCase()+x.toUpperCase()+']';})})>`;
	}

	const finder = Finder.in(conf.imagePath);
	if (req.query.start) finder.date(">", moment(new Date(req.query.start)).set({hours: 0, minutes: 0, seconds: 0, milliseconds: 0}).toISOString());
	if (req.query.end) finder.date("<", moment(new Date(req.query.end)).set({hours: 0, minutes: 0, seconds: 0, milliseconds: 0}).add(1, "day").toISOString());
	if (pageTemplate == "links") finder.size('<=', maxUrlSize);
	const files = finder.findFiles(mask);

	let page = typeof req.params.page !== "undefined" ? req.params.page : 1;
	let displayAll = false;
	if (page == "all") {
		displayAll = true;
		page = 1;
	} else if (page == "random") {
		page = Math.floor(Math.random() * Math.ceil(files.length/48)) + 1;
	} else {
		page = Math.min(Math.max(1, parseInt(page)), Math.ceil(files.length/48));
	}

	const paginationInfo = paginator.build(files.length, page);

	const fullFiles = _.reverse(_.sortBy(_.map(files, f => {
		if (statCache[f]) return statCache[f];

		console.log(f);

		const stat = fs.statSync(`${f}`);
		const ext = path.extname(f);
		const o = {
			name: path.relative(conf.imagePath, f),
			video: (_.includes(conf.videoFiles, ext.substr(1)) ? 1 : undefined), /* undefined is not saved into JSON */
			audio: (_.includes(conf.audioFiles, ext.substr(1)) ? 1 : undefined), /* undefined is not saved into JSON */
			size: stat.size,
			mtime: stat.mtime,
			mtimeSave: stat.mtime.toString(),
			c: (stat.size <= maxUrlSize && ext == "" ? fs.readFileSync(`${f}`, { encoding: "utf8" }).trim() : undefined), /* undefined is not saved into JSON */
			nonce: (nonces[f] || generateNonce(f))
		};

		statCache[f] = o;

		return o;
	}), "mtime"));

	flushStats();
	flushNonces();

	res.render(pageTemplate, {
		name: conf.name,
		background_color: conf.background_color,
		route,
		pageTemplate,
		query: url.parse(req.url).query,
		paginationInfo,
		pages: _.range(paginationInfo.first_page, paginationInfo.last_page + 1),
		files: displayAll ? fullFiles : _.slice(fullFiles, paginationInfo.first_result, paginationInfo.last_result + 1),
		imageFilesFilter,
		audioFilesFilter,
		videoFilesFilter,
		maxPasteSize,
		maxUrlSize,
		pathname
	});
}

router.get("/gallery/:page?", auth, (req, res) => fileListing(galleryMask, "gallery", pathname+"gallery", req, res));
router.get("/list/:page?", auth, (req, res) => fileListing("*", "list", pathname+"list", req, res));
router.get("/links/:page?", auth, (req, res) => fileListing("<^[^.]+$>", "links", pathname+"links", req, res));

router.get("/misc", auth, (req, res) => {
	const conf = req.config;
	res.render("misc", {
		name: conf.name,
		background_color: conf.background_color,
		url: conf.url,
		pageTemplate: "misc",
		pathname
	});
});


app.use(pathname, router);

if (typeof config.listen === "object") {
	if (typeof config.listen.port === "undefined" && typeof config.listen.path === "string" ) {
		console.log(`Listening on ${config.listen.path} under path ${pathname}`);
		process.on("exit", () => fs.unlinkSync(config.listen.path));
		if (fs.existsSync(config.listen.path)) fs.unlinkSync(config.listen.path);
	} else {
		console.log(`Listening on ${config.listen.host || ""}:${config.listen.port} under path ${pathname}`);
	}
} else {
	console.log(`Listening on ${config.listen} under path ${pathname}`);
	if (typeof config.listen === "string" && isNaN(config.listen)){
		process.on("exit", () => fs.unlinkSync(config.listen));
		if (fs.existsSync(config.listen)) fs.unlinkSync(config.listen);
	}
}

app.listen(config.listen);
