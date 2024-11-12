#!/bin/bash

pm2 flush
pm2 delete all

pm2 start /app/app.js

pm2 logs
