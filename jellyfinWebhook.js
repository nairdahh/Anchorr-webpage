import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";
import axios from "axios";

const debouncedSenders = new Map();
const sentNotifications = new Map();

function getItemLevel(itemType) {
  switch (itemType) {
    case "Series":
      return 3;
    case "Season":
      return 2;
    case "Episode":
      return 1;
    default:
      return 0;
  }
}

function minutesToHhMm(mins) {
  if (typeof mins !== "number" || isNaN(mins) || mins <= 0) return "N/A";
  const h = Math.floor(mins / 60);
  const m = Math.floor(mins % 60);
  let result = "";
  if (h > 0) result += `${h}h `;
  result += `${m}m`;
  return result;
}

async function fetchOMDbData(imdbId, omdbApiKey) {
  if (!imdbId || !omdbApiKey) return null;
  try {
    const res = await axios.get("http://www.omdbapi.com/", {
      params: { i: imdbId, apikey: omdbApiKey },
      timeout: 7000,
    });
    return res.data;
  } catch (err) {
    console.warn("OMDb fetch failed:", err?.message || err);
    return null;
  }
}

const findBestBackdrop = (details) => {
  if (details?.images?.backdrops?.length > 0) {
    const englishBackdrop = details.images.backdrops.find(
      (b) => b.iso_639_1 === "en"
    );
    if (englishBackdrop) return englishBackdrop.file_path;
  }
  return details?.backdrop_path;
};

async function processAndSendNotification(data, client, config) {
  const {
    ItemType,
    ItemId,
    Name,
    SeriesName,
    IndexNumber,
    ParentIndexNumber,
    Year,
    Overview,
    Genres,
    Provider_imdb: imdbIdFromWebhook,
    ServerId,
  } = data;

  // Remove trailing slash from ServerUrl (Jellyfin sends it with trailing slash)
  const ServerUrl = data.ServerUrl?.replace(/\/$/, '') || '';

  const tmdbId = data.Provider_tmdb;
  
  // Fetch TMDB and OMDb data in parallel
  let details = null;
  let imdbId = imdbIdFromWebhook;
  
  if (tmdbId && config.tmdb_api_key) {
    try {
      const res = await axios.get(
        `https://api.themoviedb.org/3/${
          ItemType === "Movie" ? "movie" : "tv"
        }/${tmdbId}`,
        {
          params: {
            api_key: config.tmdb_api_key,
            append_to_response: "images,external_ids,credits",
          },
          timeout: 10000,
        }
      );
      details = res.data;
      // Get IMDb ID from TMDB if available
      if (details?.external_ids?.imdb_id) {
        imdbId = details.external_ids.imdb_id;
      }
    } catch (e) {
      console.warn(`Could not fetch TMDB details for ${tmdbId}:`, e.message);
    }
  }

  // Fetch OMDb data after we have the IMDb ID
  const omdb = imdbId ? await fetchOMDbData(imdbId, config.omdb_api_key) : null;

  console.log(`[Notification] Processing ${ItemType}: ${Name || SeriesName}`);
  console.log(`[Notification] TMDB ID: ${tmdbId}, IMDb ID: ${imdbId}`);
  console.log(`[Notification] Has TMDB details: ${!!details}, Has OMDb data: ${!!omdb}`);
  console.log(`[Notification] Backdrop path: ${details ? findBestBackdrop(details) : 'none'}`);

  let runtime = "N/A";
  // Always prioritize OMDb for runtime
  if (omdb?.Runtime && omdb.Runtime !== "N/A") {
    const match = String(omdb.Runtime).match(/(\d+)/);
    if (match) {
      runtime = `${match[1]} min`;
    }
  } else if (ItemType === "Movie" && details?.runtime && details.runtime > 0) {
    // Fallback to TMDB for movies only if OMDb is not available
    runtime = minutesToHhMm(details.runtime);
  }

  // Always prioritize OMDb for rating
  const rating =
    omdb?.imdbRating && omdb.imdbRating !== "N/A"
      ? `${omdb.imdbRating}/10`
      : "N/A";
  
  const genreList = details?.genres?.map((g) => g.name).join(", ") || 
                   (Array.isArray(Genres) ? Genres.join(", ") : Genres) || 
                   "N/A";
  
  const overviewText = details?.overview || "No description available.";

  let headerLine = "Summary";
  if (ItemType === "Movie") {
    if (omdb?.Director && omdb.Director !== "N/A") {
      headerLine = `Directed by ${omdb.Director}`;
    }
  } else if (
    ItemType === "Series" ||
    ItemType === "Season" ||
    ItemType === "Episode"
  ) {
    if (details?.credits?.crew) {
      const creator = details.credits.crew.find(
        (c) => c.job === "Creator" || c.job === "Executive Producer"
      );
      if (creator) {
        headerLine = `Created by ${creator.name}`;
      }
    }
  }

  let embedTitle = "";
  let authorName = "";

  switch (ItemType) {
    case "Movie":
      authorName = "🎬 New movie added!";
      embedTitle = `${Name || "Unknown Title"} (${Year || "?"})`;
      break;
    case "Series":
      authorName = "📺 New TV show added!";
      embedTitle = `${Name || "Unknown Series"} (${Year || "?"})`;
      break;
    case "Season":
      authorName = "📺 New season added!";
      embedTitle = `${SeriesName || "Unknown Series"} (${
        Year || "?"
      }) - Season ${IndexNumber || "?"}`;
      break;
    case "Episode":
      authorName = "📺 New episode added!";
      embedTitle = `${SeriesName || "Unknown Series"} - S${String(
        ParentIndexNumber
      ).padStart(2, "0")}E${String(IndexNumber).padStart(2, "0")} - ${Name}`;
      break;
    default:
      authorName = "✨ New item added";
      embedTitle = Name || "Unknown Title";
  }

  const embed = new EmbedBuilder()
    .setAuthor({ name: authorName })
    .setTitle(embedTitle)
    .setURL(
      `${ServerUrl}/web/index.html#!/details?id=${ItemId}&serverId=${ServerId}`
    )
    .setColor(config.color_notification || "#cba6f7")
    .addFields(
      { name: headerLine, value: overviewText },
      { name: "Genre", value: genreList, inline: true },
      { name: "Runtime", value: runtime, inline: true },
      { name: "Rating", value: rating, inline: true }
    );

  const backdropPath = details ? findBestBackdrop(details) : null;
  const backdrop = backdropPath
    ? `https://image.tmdb.org/t/p/w780${backdropPath}`
    : null;
  if (backdrop) {
    embed.setImage(backdrop);
  }

  const buttonComponents = [];

  if (imdbId) {
    buttonComponents.push(
      new ButtonBuilder()
        .setStyle(ButtonStyle.Link)
        .setLabel("Letterboxd")
        .setURL(`https://letterboxd.com/imdb/${imdbId}`),
      new ButtonBuilder()
        .setStyle(ButtonStyle.Link)
        .setLabel("IMDb")
        .setURL(`https://www.imdb.com/title/${imdbId}/`)
    );
  }

  buttonComponents.push(
    new ButtonBuilder()
      .setStyle(ButtonStyle.Link)
      .setLabel("▶ Watch Now")
      .setURL(
        `${ServerUrl}/web/index.html#!/details?id=${ItemId}&serverId=${ServerId}`
      )
  );

  const buttons = new ActionRowBuilder().addComponents(buttonComponents);

  const channel = await client.channels.fetch(config.notification_channel_id);
  await channel.send({ embeds: [embed], components: [buttons] });
  console.log(`Sent notification for: ${embedTitle}`);
}

export async function handleJellyfinWebhook(
  req,
  res,
  client,
  getConfigForGuild,
  tmdbApiKey,
  omdbApiKey
) {
  try {
    const { guildId } = req.params;
    const data = req.body;

    if (!data || !data.ItemId) return res.status(400).send("No valid data");
    if (data.NotificationType !== "ItemAdded") {
      return res.status(200).send("OK: Notification type ignored.");
    }

    const config = getConfigForGuild(guildId);
    if (
      !config ||
      !config.notification_channel_id ||
      !config.jellyfin_server_url
    ) {
      console.warn(
        `Webhook received for guild ${guildId}, but it's not fully configured for notifications.`
      );
      return res
        .status(404)
        .send("Error: Guild configuration incomplete for notifications.");
    }

    // Add API keys to config
    config.tmdb_api_key = tmdbApiKey;
    config.omdb_api_key = omdbApiKey;

    if (data.ItemType === "Movie") {
      await processAndSendNotification(data, client, config);
      return res.status(200).send("OK: Movie notification sent.");
    }

    if (
      data.ItemType === "Series" ||
      data.ItemType === "Season" ||
      data.ItemType === "Episode"
    ) {
      const { SeriesId } = data;

      const sentLevel = sentNotifications.has(SeriesId)
        ? sentNotifications.get(SeriesId).level
        : 0;
      const currentLevel = getItemLevel(data.ItemType);

      if (currentLevel <= sentLevel) {
        return res
          .status(200)
          .send(
            `OK: Notification for ${data.Name} skipped, a higher-level notification was already sent.`
          );
      }

      if (!SeriesId) {
        await processAndSendNotification(data, client, config);
        return res.status(200).send("OK: TV notification sent (no SeriesId).");
      }

      if (!debouncedSenders.has(SeriesId)) {
        const debounceTimer = setTimeout(async () => {
          const debouncer = debouncedSenders.get(SeriesId);
          if (debouncer) {
            await processAndSendNotification(
              debouncer.latestData,
              client,
              config
            );

            const levelSent = getItemLevel(debouncer.latestData.ItemType);

            const cleanupTimer = setTimeout(() => {
              sentNotifications.delete(SeriesId);
              console.log(
                `Cleaned up sent notification state for SeriesId: ${SeriesId}`
              );
            }, 24 * 60 * 60 * 1000); // 24 hours

            sentNotifications.set(SeriesId, {
              level: levelSent,
              cleanupTimer: cleanupTimer,
            });

            debouncedSenders.delete(SeriesId);
          }
        }, 30000); // 30-second debounce window

        debouncedSenders.set(SeriesId, {
          timer: debounceTimer,
          latestData: data,
        });
      }

      const debouncer = debouncedSenders.get(SeriesId);
      const existingLevel = getItemLevel(debouncer.latestData.ItemType);

      if (currentLevel >= existingLevel) {
        debouncer.latestData = data;
      }

      return res
        .status(200)
        .send(`OK: TV notification for ${SeriesId} is debounced.`);
    }

    await processAndSendNotification(data, client, config);
    res.status(200).send("OK: Notification sent.");
  } catch (err) {
    console.error("Error handling Jellyfin webhook:", err);
    res.status(500).send("Error");
  }
}
