# Hubbub — real-time chat

Node.js + Express + Socket.IO + SQLite, with a plain HTML/CSS/JS frontend (no build step).

## Run
    npm install
    npm start          # http://localhost:3000
Open it in two browsers (or one normal + one incognito window), create two accounts, and chat.

## Features
Accounts (bcrypt + JWT) · 1-to-1 and group chats · instant delivery · typing indicator ·
online / last seen · sent ✓ and read ✓✓ ticks · unread badges · image and PDF sharing ·
message history · mobile layout · dark mode

## Layout
    server.js          REST API + Socket.IO events + SQLite schema
    public/index.html  screens
    public/app.js      client logic
    public/style.css   styling

## Before deploying
Set JWT_SECRET to a long random value, serve over HTTPS, and add rate limiting (express-rate-limit).
