# Mint Rush: deploy guide

This folder is the whole site:

- `index.html`: the game (3D money printer factory and the Cases section)
- `api/db.js`: a small server that runs online play (accounts, leaderboards, market, trades, battles)
- `package.json`: tells Vercel which Node version to use

With the server connected, accounts work on any device, and players can trade, sell skins to each other and battle by username.

## Put it online (about 10 minutes, all free)

1. **Upload to GitHub.** Make a free account at github.com, create a new repository (e.g. `mint-rush`), choose **uploading an existing file**, and drag in everything from this folder, including the `api` folder. Click **Commit changes**.
2. **Import into Vercel.** At vercel.com, choose **Add New → Project**, pick your `mint-rush` repository and click **Deploy**. No settings need changing.
3. **Add the database.** In your new Vercel project, open the **Storage** tab, create an **Upstash for Redis** database (the free plan is plenty), and connect it to the project. Vercel adds the connection details for you.
4. **Redeploy.** Go to **Deployments**, open the menu on the latest one and choose **Redeploy**. The server only sees the database after a fresh deploy.
5. **Check it.** Open your site. The sign-in page should show a green dot saying **"Online play is on."**

To use your own web address, add it under **Settings → Domains** in the Vercel project.

## Good to know

- **Fresh accounts.** Your site has its own database, so everyone signs up again there. Accounts from the Claude link or from an offline copy don't carry over.
- **Without the database**, the site still works in offline mode: the factory, crates and inventory save in each player's browser, with no leaderboards, market, trades or battles. Dropping just `index.html` into Vercel Drop gives you this mode, because Drop can't run the server.
- **Free-plan limits.** Each open game checks for updates about every 3 seconds and pauses when the tab is hidden. That's comfortable for a group of friends. If Upstash ever reports you've hit the free monthly limit, upgrade the database or wait for the next month.
- **Updating the game.** Replace `index.html` in your GitHub repository and Vercel redeploys automatically.
- **Play money only.** Factory cash and tokens are free, can't be bought and can't be cashed out.
- **Sharing a database with Velvet Room.** If you connect the same Upstash database you used for Velvet Room, that's fine. Mint Rush stores its data under its own name, so the two games never mix.
