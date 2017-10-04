# shitty.download

The backend behind shitty.download.

## Configuration

Make a file called `config.json`, with the following properties:

```json
{
    "logo": "poop.png",
    "name": "shitty.download",
    "name_color": "#a5673f",
    "title": "lemmmy's file host lies here",
    "disclaimer": "for dmca etc., contact drew at lemmmy dot pw",
    "password": "",
    "imagePath": "/path/to/images",
    "url": "https://your.host/",
    "listen": "3000",
    "fileLength": 4
}
```
- `logo` - Filename of your logo image. Make sure to put this in /public.
- `name` - Name of your file host.
- `name_color` - Color of your file host's name.
- `title` - Title on the homepage.
- `disclaimer` - Message used to supply important info about takedowns/dmcas, or a disclaimer.
- `password` - The sha256 hash of your password. Calculate with `echo -n 'password' | sha256sum`
- `imagePath` - The absolute path to your image storage directory.
- `url` - The full URL of your host to be prepended to image paths. Trailing slash required.
- `listen` The port or unix sock to listen to.
- `fileLength` Amount of characters in generated filenames. Default is 4.

## Notes

Ensure that the user you run the shitty.dl process as has write permissions to `imagePath`.
