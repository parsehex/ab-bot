#!/usr/bin/env bash

# is nvm installed?
if ! command -v nvm &> /dev/null; then
	echo "nvm could not be found"
	exit 1
fi

# is node v12 installed?
if ! nvm list | grep -q "v12"; then
	echo "node is not v12"
	exit 1
fi

git pull --recurse-submodules

# node_modules?
if [ ! -d "node_modules" ]; then
	npm install
fi

npm run build

if [ ! -f "start-bots.sh" ]; then
	cp "start-bots.sh.example" "start-bots.sh"
	echo "start-bots.sh created - please run the following to start 12 bots:"
	echo "bash start-bots.sh 127.0.0.1 12"
fi
