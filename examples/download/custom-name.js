const _ = require("lodash");
const fs = require("fs");

const nouns = fs.readFileSync("nouns.txt").toString().split("\n");

module.exports = () => {
	const noun = _.sample(nouns);
	return (noun.match(/^[aeiou]/i) ? "an-" : "a-") + noun;
};