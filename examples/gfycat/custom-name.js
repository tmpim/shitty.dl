const _ = require("lodash");
const fs = require("fs");

const adjectives = fs.readFileSync("adjectives.txt").toString().split("\n");
const animals = fs.readFileSync("animals.txt").toString().split("\n");

module.exports = () => {
	return (_.sampleSize(adjectives, 2).join('') + _.sample(animals));
};