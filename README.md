# THE GOAL - NO THE IDEA
Setting Up a Backup Email Server for My Homelab

Project: Rerouting Email Between Servers

The goal is to set up a secondary, cloud-hosted email server using Cloudflare as part of the infrastructure. This server acts as a backup for my primary homelab email server.

The idea is simple: if my homelab goes offline because of a power outage, internet outage, hardware failure, or even an unexpected personal emergency (such as hospitalization or death), users can still receive and send emails.

I don't want my users to lose access to their email just because my homelab is unavailable.

How It Works

1. Normal operation

Incoming emails are routed to my primary homelab email server when it is online and healthy.
If the homelab becomes unavailable, incoming emails are automatically routed to the cloud-hosted backup email server.
The backup server stores incoming emails and remains available to users.

2. What happens from the user's perspective?

There are two possible scenarios:

Scenario A: The user notices the primary server is offline.

The user tries to access their usual email server but discovers it isn't working.
They access the backup email server instead.
They log in and find their emails waiting for them.
They can continue receiving and sending emails without waiting for the homelab to come back online.

Scenario B: The user never notices anything happened.

The homelab goes offline.
Incoming emails are automatically redirected to the backup server.
The user continues using email as normal, potentially without realizing the primary server is down.

3. What happens when the homelab comes back online?

The backup server periodically checks whether the primary homelab email server is available again.

Backup server: "Hey, homelab! You're back online. Are you ready to receive your backed-up emails?"
Homelab: "Yes, send them over."
Backup server: Transfers the queued emails to the primary server.
Homelab: Receives and processes the backed-up emails.

The user can then log back into their usual email server and find their missing emails waiting for them.

The end result: The user might never even know the primary server went offline.

4. Disaster Recovery: What If I'm Unavailable?

This is one of the most important reasons for having this backup system.

I'm not assuming I'll always be available to maintain the infrastructure. Life happens. I could lose power or internet access, end up in the hospital, or, in the worst-case scenario, die.

I don't want users to become permanently dependent on infrastructure that nobody else can maintain.

To account for this, I've established a 7-day warning period:

If the backup email server remains active for more than seven consecutive days because the primary server is unavailable, users should treat this as a potential long-term outage.
If they cannot get in contact with me during that period, they should begin changing their registered email addresses on websites, services, and accounts to an email provider they control.
This gives users time to migrate away from my infrastructure before they potentially lose access to it.

The backup server is there to keep everyone operational, but it is also there to give users an escape route if something happens to me.

The Overall Goal

I want to provide two ways for users to access their email:

Primary email server: My homelab, which handles normal email operations.
Backup email server: A cloud-hosted alternative that takes over when the primary server is unavailable.

This isn't just about redundancy or preventing downtime. It's about making sure that the people who rely on my infrastructure aren't left stranded if something happens to me.

My philosophy is simple: If I disappear tomorrow, my users should still have access to their emails and enough time to move on without me.

<p align="center">
    <img src="doc/demo/logo.png" width="80px" />
    <h1 align="center">Cloud Mail</h1>
    <p align="center">An all-in-one email service platform powered by Cloudflare</p>
    <p align="center">
        <a href="https://www.cloudflare.com/" target="_blank">
            <img src="https://img.shields.io/badge/Cloudflare-F38020?labelColor=F38020&amp;color=F38020&amp;logo=cloudflare&amp;logoColor=white" alt="Cloudflare" />
        </a>
        <a href="https://github.com/maillab/cloud-mail/releases" target="_blank" >
            <img src="https://img.shields.io/github/v/release/maillab/cloud-mail?logo=github&amp;logoColor=white" alt="releases" />
        </a>
        <a href="https://github.com/maillab/cloud-mail/tree/main?tab=MIT-1-ov-file" target="_blank" >
            <img src="https://img.shields.io/badge/license-MIT-green" />
        </a>
    </p>
    <p align="center">
        <a href="https://skymail.ink">Live Demo</a> · <a href="https://docs.skymail.ink/en/">Deployment Guide</a> ·
        <a href="https://github.com/maillab/cloud-mail/blob/main/README.md">简体中文</a> | English | <a href="/README-ja.md">日本語</a>
    </p>
    <p align="center">
        <a href="https://trendshift.io/repositories/20459" target="_blank" >
            <img src="https://trendshift.io/api/badge/repositories/20459" alt="trendshift" >
        </a>
        <a href="https://hellogithub.com/repository/1b1da1f9ae4c4175baa3d762b4e0ba41" target="_blank">
            <img src="https://api.hellogithub.com/v1/widgets/recommend.svg?rid=1b1da1f9ae4c4175baa3d762b4e0ba41" alt="HelloGitHub" />
        </a>
    </p>
</p>

## Description
With only one domain, you can create multiple different email addresses, similar to major email platforms. This project can be deployed on Cloudflare Workers to reduce server costs and build your own email service.
## Project Showcase

| ![](/doc/demo/en/demo.jpg)  | ![](/doc/demo/en/demo1.jpg) |
|-----------------------------|-----------------------------|
| ![](/doc/demo/en/demo2.jpg) | ![](/doc/demo/en/demo3.jpg) |

## Recommended Project

<table>
  <tr>
    <td valign="middle">
      <a href="https://github.com/pixtalelab/pixtale">
        <img width="30" src="https://img.022335.xyz/logo.png" alt="Pixtale" align="middle">
      </a>
    </td>
    <td valign="middle">
      <a href="https://github.com/pixtalelab/pixtale">Pixtale</a>
    </td>
    <td valign="middle">
      A self-hosted cloud storage photo album app
    </td>
  </tr>
</table>

## Features

- **💰 Low-Cost Usage**: No server required — deploy to Cloudflare Workers to reduce costs.

- **💻 Responsive Design**: Automatically adapts to both desktop and most mobile browsers.

- **📧 Email Sending**: Integrated with Cloudflare Email and Resend for sending email.

- **🛡️ Admin Features**: Admin controls for user and email management with RBAC-based access control.

- **📦 Attachment Support**: Send and receive attachments, stored and downloaded via R2 object storage.

- **🔔 Email Push**: Forward received emails to Telegram bots or other email providers.

- **📡 Open API**: Supports batch user creation via API and multi-condition email queries

- **🔢 Verification Code Recognition**: Auto-detect codes via Workers AI

- **📈 Data Visualization**: Use ECharts to visualize system data, including user email growth.

- **🎨 Personalization**: Customize website title, login background, and transparency.

- **🤖 CAPTCHA**: Integrated with Turnstile CAPTCHA to prevent automated registration.

- **📜 More Features**: Under development...

## Tech Stack

- **Platform**: [Cloudflare Workers](https://developers.cloudflare.com/workers/)

- **Web Framework**: [Hono](https://hono.dev/)

- **ORM**: [Drizzle](https://orm.drizzle.team/)

- **Frontend Framework**: [Vue3](https://vuejs.org/)

- **UI Framework**: [Element Plus](https://element-plus.org/)

- **Email Sending**: [Cloudflare Email](https://developers.cloudflare.com/email-service/) / [Resend](https://resend.com/)

- **Cache**: [Cloudflare KV](https://developers.cloudflare.com/kv/)

- **Database**: [Cloudflare D1](https://developers.cloudflare.com/d1/)

- **File Storage**: [Cloudflare R2](https://developers.cloudflare.com/r2/)

## Project Structure

```
cloud-mail
├── mail-worker                    # Backend worker project
│   ├── src
│   │   ├── api                    # API layer
│   │   ├── const                  # Project constants
│   │   ├── dao                    # Data access layer
│   │   ├── email                  # Email processing and handling
│   │   ├── entity                 # Database entities
│   │   ├── error                  # Custom exceptions
│   │   ├── hono                   # Web framework, middleware, error handling
│   │   ├── i18n                   # Internationalization
│   │   ├── init                   # Database and cache initialization
│   │   ├── model                  # Response data models
│   │   ├── security               # Authentication and authorization
│   │   ├── service                # Business logic layer
│   │   ├── template               # Message templates
│   │   ├── utils                  # Utility functions
│   │   └── index.js               # Entry point
│   ├── package.json               # Project dependencies
│   └── wrangler.toml              # Project configuration
│
├── mail-vue                       # Frontend Vue project
│   ├── src
│   │   ├── axios                  # Axios configuration
│   │   ├── components             # Custom components
│   │   ├── echarts                # ECharts integration
│   │   ├── i18n                   # Internationalization
│   │   ├── init                   # Startup initialization
│   │   ├── layout                 # Main layout components
│   │   ├── perm                   # Permissions and access control
│   │   ├── request                # API request layer
│   │   ├── router                 # Router configuration
│   │   ├── store                  # Global state management
│   │   ├── utils                  # Utility functions
│   │   ├── views                  # Page components
│   │   ├── app.vue                # Root component
│   │   ├── main.js                # Entry JS file
│   │   └── style.css              # Global styles
│   ├── package.json               # Project dependencies
└── └── env.release                # Environment configuration

```

## License

This project is licensed under the [MIT](LICENSE) license.

## Communication

[Telegram](https://t.me/cloud_mail_tg)
