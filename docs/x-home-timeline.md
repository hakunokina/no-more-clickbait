# X HomeTimeline response shape

Field paths the parser (`packages/core/src/x/home-timeline.ts`) reads from an
X `HomeTimeline` GraphQL response. Derived from the structure of real captures;
no real values are recorded here. The shape is undocumented and drifts — the
parser skips and counts anything it does not recognise instead of throwing.
Synthetic examples: `packages/core/fixtures/x-home-timeline/`.

## Envelope

```
data.home.home_timeline_urt.instructions[]
  .type                        TimelineAddEntries | TimelineReplaceEntry |
                               TimelinePinEntry | TimelineAddToModule |
                               TimelineClearCache | TimelineTerminateTimeline | …
  .entries[]                   (TimelineAddEntries)
  .entry                       (TimelineReplaceEntry, TimelinePinEntry)
  .moduleEntryId, .moduleItems[]   (TimelineAddToModule)
```

## Entries

```
entry.entryId                  "tweet-<id>" | "promoted-tweet-<id>-<hex>" |
                               "who-to-follow-<n>" | "cursor-top-<n>" | "cursor-bottom-<n>" |
                               "home-conversation-<n>" | …
entry.content.entryType        (= __typename)
  TimelineTimelineCursor       .cursorType Top|Bottom, .value
  TimelineTimelineItem         .itemContent (below)
  TimelineTimelineModule       .items[].entryId, .items[].item.itemContent
                               .displayType, .header, .footer
entry.content.clientEventInfo.component
                               for_you_in_network | for_you_simclusters |
                               for_you_phoenix_retrieval | for_you_promoted | …
```

- Item: `itemContent.itemType` = `TimelineTweet` (tweet) or `TimelineUser`, …
- Promoted: `entryId` starts with `promoted`, and `itemContent.promotedMetadata`
  is present (ad entries may also carry `itemContent.prerollMetadata`).
- Modules: `who-to-follow-*` holds `TimelineUser` items (suggestions, skipped);
  conversation modules (`home-conversation-*`) hold tweet items (parsed).

## Tweet result

```
itemContent.tweet_results.result.__typename
  Tweet                        the tweet itself
  TweetWithVisibilityResults   wrapper → .tweet (Tweet), .limitedActionResults
  TweetTombstone, TweetUnavailable   no content (skipped)
```

On a `Tweet` (call it `T`):

| Field                              | Path                                                                                                                                                                   |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| id                                 | `T.rest_id` (`T.legacy.id_str`)                                                                                                                                        |
| text                               | `T.legacy.full_text` (HTML-escaped `&amp; &lt; &gt;`; trailing media/quote short links)                                                                                |
| long text                          | `T.note_tweet.note_tweet_results.result.text`, its links in `.entity_set.urls[]`                                                                                       |
| created                            | `T.legacy.created_at` (`"Thu Jan 01 11:58:00 +0000 2026"`)                                                                                                             |
| language                           | `T.legacy.lang` (`und`/`zxx` when undetermined)                                                                                                                        |
| links                              | `T.legacy.entities.urls[].url` (short) → `.expanded_url`                                                                                                               |
| media                              | `T.legacy.extended_entities.media[]` (fallback `entities.media[]`): `.type` photo/video/animated_gif, `.media_url_https`, `.url` (short link in text), `.ext_alt_text` |
| card                               | `T.card.legacy.name`, `.binding_values[].key/.value.string_value` (`unified_card` JSON in ads; often only `T.card.rest_id`)                                            |
| media size                         | `media[].original_info.width/height`                                                                                                                                   |
| video / GIF                        | `media[].video_info.duration_millis` (video), `.variants[].content_type/bitrate/url` (`video/mp4` + an HLS `application/x-mpegURL` without bitrate)                    |
| likes / reposts / replies / quotes | `T.legacy.favorite_count` / `retweet_count` / `reply_count` / `quote_count`                                                                                            |
| views                              | `T.views.count` (string), `T.views.state`                                                                                                                              |
| reply                              | `T.legacy.in_reply_to_status_id_str`, `in_reply_to_screen_name`                                                                                                        |
| repost                             | `T.legacy.retweeted_status_result.result` (original; `full_text` is a truncated `RT @…` copy)                                                                          |
| quote                              | `T.quoted_status_result.result` (may be wrapped), `T.legacy.is_quote_status`, `T.legacy.quoted_status_permalink.url` (short link in text)                              |

Author, `U = T.core.user_results.result`:

| Field    | Path                                                                                            |
| -------- | ----------------------------------------------------------------------------------------------- |
| handle   | `U.core.screen_name` (older: `U.legacy.screen_name`)                                            |
| name     | `U.core.name` (older: `U.legacy.name`)                                                          |
| verified | `U.is_blue_verified`, `U.verification.verified`, `U.verification.verified_type` (e.g. Business) |
| avatar   | `U.avatar.image_url` (older: `U.legacy.profile_image_url_https`)                                |

## Mapping to `Post`

- Repost → the original post, `repostedBy` = reposter handle (so duplicate
  originals share one id).
- Quote → `quoted { id, authorHandle, text, authorName?, authorVerified?,
publishedAt?, media? }`; the permalink short link is removed from the text.
- Photo/video/GIF → `url` (photo, or the poster for video/GIF), `width/height`
  from `original_info`, `durationMs` (video), `variants` = MP4 renditions only,
  highest bitrate first.
- Link card → `media[type=link].card { title?, description?, domain?, image? }`
  from `binding_values` (`title`, `description`, `vanity_url`/`domain`, the
  largest `*_image_original` image), on the link whose short URL is
  `card_url`, else the last link. Organic tweets mostly carry only
  `card.rest_id`, and that is usually the short URL of an attached video —
  no link card then.
- Author avatar → `authorAvatarUrl` (X serves the `_normal` 48 px size).
- Short links replaced by their expanded URL in `text` and added as `link`
  media; media short links removed.
- No own text, no quoted text, only media → `mediaOnly: true` (kept, flagged).
- `url` = `https://x.com/<handle>/status/<id>`.

What the hard filter (`packages/core/src/hard-filter.ts`) then drops, with
counters: promoted posts, repeated post ids across responses, repeated
originals via reposts.
