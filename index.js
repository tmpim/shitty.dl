const package = require("./package.json");
const version = package.version;
const config = require(process.argv[2] || "./config.json");

const _ = require("lodash");

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
const helpers = require("handlebars-helpers")();
const dateformat = require("helper-dateformat");
const Finder = require("fs-finder");
const moment = require("moment");

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

let nonces = {};
let noncesLookup = {};

let statCache = {version};

let customName;
if (fs.existsSync("custom-name.js")) {
	customName = require("./custom-name.js");
}

if (fs.existsSync("stats.json")) {
	statCache = JSON.parse(fs.readFileSync("stats.json"));
	if (statCache.version !== version) statCache = { version }; /* note: remember to change version every time stats.json format changes */
	else {
		_.forOwn(statCache, (value, key) => {
			if ( key === "version" ) return;
			value.mtime = new Date(value.mtimeSave);
		});
	}
}

if (fs.existsSync("nonces.json")) {
	nonces = JSON.parse(fs.readFileSync("nonces.json"));
	_.forOwn(nonces, (value, key) => {
		noncesLookup[nonces[key]] = key;
	});
}

const pathname = new url.URL(config.url).pathname.replace(/\/?$/, "/");

if (!config.sessionSecret) {
	console.error("Please put a secure random value in config.sessionSecret");
	process.exit(0);
}

if (!config.password.match(/^[0-9a-f]{64}$/i)) {
	console.error("Password does not look like an sha256 hash. Read the damn docs");
	process.exit(0);
}

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

if (!fs.existsSync(`${config.imagePath}/.deleted`)){
    fs.mkdirSync(`${config.imagePath}/.deleted`);
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
		base64: data => Buffer.from(data).toString("base64")
	})
}));
app.set("view engine", ".hbs");
app.use(session({
	secret: config.sessionSecret,
	cookie: {},
	resave: false,
	saveUninitialized: true
}));

bb.extend(app, {
	upload: true
});

function error(req, res, error) {
	console.error(util.inspect(error, {
		depth: null,
		colors: true,
		showHidden: true
	}));

	if (req.xhr || req.headers.accept.indexOf('json') > -1) {
		res.json({ ok: false, error });
	} else {
		res.render("error", { errorText: error });
	}
}

function success(req, res, success) {
	if (req.xhr || req.headers.accept.indexOf('json') > -1) {
		res.json({ ok: true, success });
	} else {
		res.render("success", { successText: success });
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

app.use(promBundle({
	includeMethod: true,
	includePath: true,
	normalizePath: req => {
		return url.parse(req.originalUrl).pathname;
	}
}));

function auth(req, res, next) {
	if (!req.session || !req.session.authed) {
		return res.redirect(pathname);
	}

	next();
}

router.use(express.static("public"));
router.use(express.static(config.imagePath));

router.get(["/", "/home"], (req, res) => {
	res.render("home", {
		config: _.omit(config, ["password", "sessionSecret"]),
		authed: req.session && req.session.authed,
		pathname
	});
});

router.post("/login", (req, res) => {
	if (!req.body.password) return error(req, res, "No password specified.");
	if (crypto.createHash("sha256").update(req.body.password).digest("hex") !== config.password) return error(req, res, "Incorrect password.");

	req.session.authed = true;
	req.session.save();

	res.redirect(pathname+"gallery");
});

router.get("/upload", auth, (req, res) => {
	res.render("upload", {
		config: _.omit(config, ["password", "sessionSecret"]),
		pageTemplate: "upload",
		pathname
	});
});

router.post("/upload", (req, res) => {
	if ( typeof req.body.link === "undefined" && typeof req.body.file === "undefined" && (!req.files || !req.files.file)) return error(req, res, "No file/URL specified.");

	if (!req.session || !req.session.authed) {
		if (!req.body.password) return error(req, res, "No password specified.");
		if (crypto.createHash("sha256").update(req.body.password).digest("hex") !== config.password) return error(req, res, "Incorrect password.");
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

	if (ext.toLowerCase() === ".php") return error(req, res, "Disallowed file type.");

	let name;
	let attempts = 0;

	do {
		if (attempts === 0 && req.body.name && req.body.name.length > 0) {
			name = req.body.name.replace(/[^A-Za-z0-9_\-]/g, "_");
		} else {
			if (customName) {
				name = customName();
			} else {
				name = cr.next();
			}
		}

		attempts++;

		if (attempts > 20) {
			return error(req, res, "Could not generate unique filename after 20 attempts.");
		}
	} while (fs.existsSync(`${config.imagePath}/${name}${ext}`));

	if (req.body.link) {
		fs.writeFile(`${config.imagePath}/${name}`, req.body.link, (err) => {
			if (err) {
					   error(req, res, "Upload failed.");
					   return console.log(JSON.stringify(err));
			}
			let nonce = generateNonce(`${config.imagePath}/${name}`);
			flushNonces();
			name = "l/" + name;

			if (req.body.online === "yes") {
				success(req, res, `URL shortened to <a href="${config.url}${name}">"${config.url}${name}"</a>` );
			} else {
				res.json({
					ok: true,
					url: `${config.url.replace(/\/?$/, "/")}${name}`,
					deleteUrl: config.uploadDeleteLink ? `${config.url.replace(/\/?$/, "/")}delete/${nonce}` : undefined
				});
			}
		});
	} else if (file) {
		fs.writeFile(`${config.imagePath}/${name}${ext}`, file, (err) => {
			if (err) {
					   error(req, res, "Upload failed.");
					   return console.log(JSON.stringify(err));
			}
			let nonce = generateNonce(`${config.imagePath}/${name}${ext}`);
			flushNonces();

			if (req.body.online === "yes") {
				res.redirect(`${config.url}${name}${ext}`);
			} else {
				res.json({
					ok: true,
					url: `${config.url.replace(/\/?$/, "/")}${name}${ext}`,
					deleteUrl: config.uploadDeleteLink ? `${config.url.replace(/\/?$/, "/")}delete/${nonce}` : undefined
				});
			}
		});
	} else {
		moveFile(req.files.file.file, `${config.imagePath}/${name}${ext}`, err => {
			if (err) {
					   error(req, res, "Upload failed.");
					   return console.log(JSON.stringify(err));
			}
			let nonce = generateNonce(`${config.imagePath}/${name}${ext}`);
			flushNonces();

			if (typeof req.query.paste !== "undefined") {
				name = "paste/" + name;
			}

			if (req.body.online === "yes") {
				res.redirect(`${config.url}${name}${ext}`);
			} else {
				res.json({
					ok: true,
					url: `${config.url.replace(/\/?$/, "/")}${name}${ext}`,
					deleteUrl: config.uploadDeleteLink ? `${config.url.replace(/\/?$/, "/")}delete/${nonce}` : undefined
				});
			}
		});
	}
});

router.all("/delete/:nonce", (req, res) => {
	if (typeof req.params.nonce === "undefined" || typeof noncesLookup[req.params.nonce] === "undefined") return error(req, res, "Invalid nonce provided");

	if (!config.uploadDeleteLink && ( !req.session || !req.session.authed ) ) {
		if (!req.body.password) return error(req, res, "No password specified.");
		if (crypto.createHash("sha256").update(req.body.password).digest("hex") !== config.password) return error(req, res, "Incorrect password.");
	}

	const filePath = noncesLookup[req.params.nonce];
	const fileName = path.basename(filePath);

	if (!fs.existsSync(filePath)) return error(req, res, "File don't exist");

	moveFile( filePath , `${config.imagePath}/.deleted/${fileName}`, err => {
		if (err) {error(req, res, "Deletion Failed."); return console.log(JSON.stringify(err));}
		success(req, res, `File ${fileName} deleted successfuly`);
		removeNonce(req.params.nonce)
	});
});

router.post("/rename", (req, res) => {
	if ( typeof req.body.nonce === "undefined" || typeof req.body.name === "undefined" || typeof noncesLookup[req.body.nonce] === "undefined" ) return error(req, res, "No file specified.");

	if (!req.session || !req.session.authed) {
		if (!req.body.password) return error(req, res, "No password specified.");
		if (crypto.createHash("sha256").update(req.body.password).digest("hex") !== config.password) return error(req, res, "Incorrect password.");
	}

	const filePath = noncesLookup[req.body.nonce];
	const fileName = path.basename(filePath);
	const name = sanitizeFilename(req.body.name);

	if (!fs.existsSync(filePath)) return error(req, res, "File don't exist");
	if (fs.existsSync(`${config.imagePath}/${name}`)) return error(req, res, "Filename already in use.");
	if (path.extname(name).toLowerCase() === ".php") return error(req, res, "Disallowed file type.");

	moveFile( filePath , `${config.imagePath}/${name}`, err => {
		if (err) {error(req, res, "Rename Failed."); return console.log(JSON.stringify(err));}
		success(req, res, `File ${fileName} renamed to ${name} successfuly`);
		removeNonce(req.body.nonce)
	});
});

router.post("/edit", (req, res) => {
	if ( typeof req.body.nonce === "undefined" && typeof req.body.file === "undefined" || typeof noncesLookup[req.body.nonce] === "undefined" ) return error(req, res, "No file specified.");

	if (!req.session || !req.session.authed) {
		if (!req.body.password) return error(req, res, "No password specified.");
		if (crypto.createHash("sha256").update(req.body.password).digest("hex") !== config.password) return error(req, res, "Incorrect password.");
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
		success(req, res, `File ${fileName} edited successfuly`);
	});
});

router.get("/paste/:file", (req, res) => {
	const filename = sanitizeFilename(req.params.file);
	const filePath = path.join(config.imagePath, filename);

	if (!filePath) return res.status(404).send("File not found");

	try {
		if (!fs.existsSync(filePath))  return res.status(404).send("File not found");
		const stats = fs.statSync(filePath);

		//console.log(stats);

		if (!stats.isFile()) return res.status(404).send("File not found");
		if (stats.size > 2 ** 19) return error(req, res, `File too large (${filesize(stats.size)})`);

		const html = highlighter
			? highlighter.highlightSync({filePath})
			: "<pre class='editor'>" + _.escape(fs.readFileSync(filePath).toString()) + "</pre>";

		res.render("paste", {
			paste: html,
			style: config.pasteThemePath || "https://atom.github.io/highlights/examples/atom-dark.css",
			name: filename,
			pathname,
			layout: false
		});
	} catch (err) {
		error(req, res, err);
	}
});

router.get("/edit/:file", (req, res) => {
	
	if (!req.session || !req.session.authed) {
		if (!req.body.password) return error(req, res, "No password specified.");
		if (crypto.createHash("sha256").update(req.body.password).digest("hex") !== config.password) return error(req, res, "Incorrect password.");
	}
	const filename = sanitizeFilename(req.params.file);
	const filePath = path.join(config.imagePath, filename);
	const ext = path.extname(filePath)

	if (!filePath) return res.status(404).send("File not found");

	try {
		if (!fs.existsSync(filePath))  return res.status(404).send("File not found");
		const stats = fs.statSync(filePath);

		//console.log(stats);

		if (!stats.isFile()) return res.status(404).send("File not found");
		if (stats.size > 2 ** 19) return error(req, res, `File too large (${filesize(stats.size)})`);

		const filecontents = fs.readFileSync(filePath, { encoding: "utf8" });

		res.render("edit", {
			filecontents,
			name: filename,
			nonce: nonces[filePath],
			pathname,
			layout: false
		});
	} catch (err) {
		error(req, res, err);
	}
});

router.get("/l/:file", (req, res) => {
	const filename = sanitizeFilename(req.params.file);
	const filePath = path.join(config.imagePath, filename);

	if (!filePath) return res.status(404).send("File not found");
	if (path.extname(filePath)) return error(req, res, "URL not valid");

	try {
		if (!fs.existsSync(filePath))  return res.status(404).send("File not found");
		const stats = fs.statSync(filePath);

		if (!stats.isFile()) return res.status(404).send("File not found");
		if (stats.size > 1024) return error(req, res, `URL too large (${filesize(stats.size)})`);

		res.redirect(fs.readFileSync(filePath, { encoding: "utf8" }).trim());
	} catch (err) {
		error(req, res, err);
	}
});

function fileListing(mask, pageTemplate, route, req, res) {
	if (req.query.search) {
		mask = config.imagePath+`*<(${req.query.search.split(",").join("|").replace(/[a-zA-Z]/g, x => {return '['+x.toLowerCase()+x.toUpperCase()+']';})})>`;
	}

	const finder = Finder.from(config.imagePath);
	if (req.query.start) finder.date(">", moment(new Date(req.query.start)).set({hours: 0, minutes: 0, seconds: 0, milliseconds: 0}).toISOString());
	if (req.query.end) finder.date("<", moment(new Date(req.query.end)).set({hours: 0, minutes: 0, seconds: 0, milliseconds: 0}).add(1, "day").toISOString());
	if (pageTemplate == "links") finder.size('<=', 1024);
	const files = finder.findFiles(mask);

	let page = typeof req.params.page !== "undefined" ? parseInt(req.params.page) : 0;
	page = Math.min(Math.max(0, page), files.length);

	const paginationInfo = paginator.build(files.length, page);

	const fullFiles = _.reverse(_.sortBy(_.map(files, f => {
		if (statCache[f]) return statCache[f];

		console.log(f);

		const stat = fs.statSync(`${f}`);
		const ext = path.extname(f);
		const o = {
			name: path.relative(config.imagePath, f),
			video: ( ext == ".mp4" || ext == ".webm" ? 1 : undefined), /* undefined is not saved into JSON */
			size: stat.size,
			mtime: stat.mtime,
			mtimeSave: stat.mtime.toString(),
			c: (stat.size <= 1024 && ext == "" ? fs.readFileSync(`${f}`, { encoding: "utf8" }).trim() : undefined), /* undefined is not saved into JSON */
			nonce: (nonces[f] || generateNonce(f))
		};

		statCache[f] = o;

		return o;
	}), "mtime"));

	flushStats();
	flushNonces();

	res.render(pageTemplate, {
		route,
		pageTemplate,
		query: url.parse(req.url).query,
		paginationInfo,
		pages: _.range(paginationInfo.first_page, paginationInfo.last_page + 1),
		files: _.slice(fullFiles, paginationInfo.first_result, paginationInfo.last_result + 1),
		pathname
	});
}

router.get("/gallery/:page?", auth, (req, res) => fileListing("*.<(jpeg|jpg|png|gif|mp4|webm)$>", "gallery", pathname+"gallery", req, res));
router.get("/list/:page?", auth, (req, res) => fileListing("*", "list", pathname+"list", req, res));
router.get("/links/:page?", auth, (req, res) => fileListing("<^[^.]+$>", "links", pathname+"links", req, res));

router.get("/misc", auth, (req, res) => {
	res.render("misc", {
		config: _.omit(config, ["password", "sessionSecret"]),
		pageTemplate: "misc",
		pathname
	});
});

console.log(`Listening on ${config.listen} under path ${pathname}`);

app.use(pathname, router);
if (typeof config.listen === "string" && isNaN(config.listen)){
	process.on("exit", () => fs.unlinkSync(config.listen));
	if (fs.existsSync(config.listen)) fs.unlinkSync(config.listen);
}
app.listen(config.listen);
