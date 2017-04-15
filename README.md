# shitty.download

The backend behind shitty.download.

## Configuration

Make a file called `config.json`, with the following properties:

```json
{
    "password": "",
    "imagePath": "/path/to/images",
    "url": "https://your.host/",
    "listen": "3000"
}
```

- `password` - The sha256 hash of your password. Calculate with `echo -n 'password' | sha256sum`
- `imagePath` - The absolute path to your image storage directory.
- `url` - The full URL of your host to be prepended to image paths. Trailing slash required.
- `listen` The port or unix sock to listen to.

## Notes

Ensure that the user you run the shitty.dl process as has write permissions to `imagePath`.
