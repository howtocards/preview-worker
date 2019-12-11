# preview-worker

## Setup

```sh
yarn
```

## Configuration

with env variables

- **CALLBACK_HOST** — Internal API that called after screenshoting. default: `http://localhost:9002`
- **POOL_SIZE** — Count of tabs in browser. default `require('os').cpus().length / 2`
- **QUEUE_NAME** — Queue name in Rabbit. default `howtocards:render`
- **RABBIT_HOST** — RabbitMQ server. default `amqp://localhost:5672`
- **RENDER_HOST** — Howtocards Frontend instance. default `https://howtocards.io`
- **UPLOADER_HOST** — Image Uploader internal API. default `http://localhost:4000`

## Development

- `yarn start` to run worker
- `CTRL+C` — shutdown worker

#### Docker

```bash
docker run -v `pwd`/the-files:/files -it -e "VOLUME=/files" --expose 4000  howtocards/image-uploader/image-uploader
```

## API

Worker subscribes to tasks from `QUEUE_NAME` at `RABBIT_HOST`.

Task types:

- `{ "user": "@sergeysova", "extra": {}, "callback": "/preview/user/@sergeysova" }` — to render `/@sergeysova`
- `{ "card": "2", "extra": {}, "callback": "/preview/card/2" }` — to render `/open/2`

Steps:

1. Task received
2. Tab consumed from pool
3. Task rendered by specified type

   - `user` just makes screenshot of user page
   - `card` makes screenshot of card, and get snapshot. Frontend should render with Slate

4. Tab returned to pool
5. Screenshot is uploaded to `UPLOADER_HOST`
6. If `.callback` present send POST request to `{CALLBACK_HOST}/{callback}` with JSON body `{ "screenshot": "/abcd/efgh/asdasd.png", "snapshot": "<div></div>" }`

   - snapshot generated only for `card`
   - `user` sends only `{"screenshot": ""}`
   - `screenshot` is a path relative to `https://howtocards.io/images`
