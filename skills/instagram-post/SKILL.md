---
name: instagram-post
description: Post a carousel or single image on Instagram through the signed-in browser at instagram.com, without posting twice, and record the post's link.
---

# Before you start

- The post folder holds the slides (slide-01.jpg, slide-02.jpg, …) and caption.md. Post exactly those, in order, and the caption exactly as written.
- Open https://www.instagram.com/. If it shows a sign-in page, a security code or a "suspicious login" check, call request_takeover and wait. Never type a password.
- Close pop-ups such as "Turn on notifications" or "Save your login info?" with "Not now".

# Check it is not already posted

Open the profile (the link with the account's username in the left menu) and open the newest post. If its caption starts with the same first line as caption.md, it is already live: record its link (below) and stop. A task that was interrupted after sharing would otherwise post it twice.

# Post

1. Click "Create" in the left menu, then "Post" if a small menu opens.
2. In "Create new post", call browser_upload on "Select from computer" with every slide in order.
3. Click the crop button at the bottom left of the image and choose "4:5" (or "Original"), so no slide is cut. Click "Next".
4. Skip filters: click "Next".
5. Click the caption box ("Write a caption...") and type the caption from caption.md with browser_type, without submit.
6. Click "Share". Uploading can take a minute: use browser_snapshot until it says the post has been shared.

If something fails after "Share" (an error, a spinner that never ends), do not click "Share" again. Check the profile first, and post again only if the post is not there.

If Instagram says an action is blocked or limited, stop and report it. Never try again the same day.

# Record it

Open the profile, open the newest post, and note its address (https://www.instagram.com/p/…/). Write it, with the date and time, to published.md in the post folder, and report it.

Instagram allows up to 20 images in a carousel and 2,200 characters in a caption.
