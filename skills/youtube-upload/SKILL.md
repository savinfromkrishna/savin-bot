---
name: youtube-upload
description: Upload a finished video to YouTube as a draft, with the integration or through YouTube Studio, only to the channel assigned for uploads.
---

Every upload goes to the one channel assigned for uploads (Integrations → YouTube). Never upload to another channel, and never switch channels in YouTube Studio.

# With the YouTube integration

Use `youtube_upload_video` with the file path, title, description and tags from the post folder. Keep privacy `private` unless the brand allows public posts.

# Through the browser

Use `youtube_studio_upload` with the file path, title, description and privacy. It opens YouTube Studio on the assigned channel, fills the upload dialog and waits until the upload finishes.

If it stops partway, the upload dialog is still open in your browser tab; finish it with the browser tools:

1. Fill Title and Description exactly as written in the post folder.
2. Thumbnail: `browser_upload` the thumbnail on "Upload file" under Thumbnail.
3. Audience: choose "No, it's not made for kids" unless told otherwise.
4. Click Next until Visibility; choose Private (or Schedule if a date is given). Save.
5. Report the video link from the final dialog.
