<html>

<head>
    <meta http-equiv="Content-Type" content="text/html; charset=utf-8" />
    <meta name="viewport" content="width=device-width" />
    <style type="text/css">
        /* CLIENT-SPECIFIC STYLES */
        #outlook a { padding: 0; }
        .ReadMsgBody { width: 100%; }
        .ExternalClass { width: 100%; }
        .ExternalClass, .ExternalClass p, .ExternalClass span, .ExternalClass font,
        .ExternalClass td, .ExternalClass div { line-height: 100%; }
        body, table, td, a { -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
        table, td { mso-table-lspace: 0pt; mso-table-rspace: 0pt; }
        img { -ms-interpolation-mode: bicubic; }

        /* RESET STYLES */
        img { border: 0; height: auto; line-height: 100%; outline: none; text-decoration: none; }
        table { border-collapse: collapse !important; }
        body { height: 100% !important; margin: 0; padding: 0; width: 100% !important; }

        /* iOS BLUE LINKS */
        .appleBody a { color: #333333; text-decoration: none; }
        .appleFooter a { color: #999999; text-decoration: none; }

        /* MOBILE STYLES */
        @media screen and (max-width: 525px) {
            table[class="wrapper"] { width: 100% !important; }
            td[class="logo"] { text-align: left; padding: 20px 0 20px 0 !important; }
            td[class="logo"] img { margin: 0 auto !important; }
            td[class="mobile-hide"] { display: none; }
            img[class="mobile-hide"] { display: none !important; }
            td[class="padding-copy"] { padding: 10px 5% 10px 5% !important; text-align: center; }
            td[class="padding-meta"] { padding: 30px 5% 0px 5% !important; text-align: center; }
            td[class="stack"] { display: block !important; width: 100% !important; padding: 0 0 12px 0 !important; }
        }
    </style>
</head>

<body bgcolor="#f4f5f7" style="margin: 0; padding: 0; background-color: #f4f5f7;">

    <!-- Hidden preheader text (shows next to the subject in the inbox) -->
    <div style="display: none; max-height: 0px; overflow: hidden; font-size: 1px; line-height: 1px; color: #f4f5f7;">
        Welcome! Complete your <? GetScopeSpecificPreheader(); ?> account setup and start exploring your new environment.
    </div>

    <!-- HEADER / LOGO -->
    <table border="0" cellpadding="0" cellspacing="0" width="100%" bgcolor="#ffffff">
        <tr>
            <td bgcolor="#ffffff">
                <div align="center" style="padding: 0px 15px 0px 15px;">
                    <table border="0" cellpadding="0" cellspacing="0" width="580" class="wrapper">
                        <tr>
                            <td style="padding: 22px 0px 22px 0px;" class="logo">
                                <table border="0" cellpadding="0" cellspacing="0" width="100%">
                                    <tr>
                                        <td bgcolor="#ffffff" width="200" align="left">
                                            <img alt="Logo" src="https://<? GetFQDN(); ?>/SiPbx/getimage.php?filename=portal_main_top_left.png&territory=<? GetTerritory(); ?>&domain=<? GetDomain(); ?>" style="display: block; font-family: Helvetica, Arial, sans-serif; color: #666666; font-size: 16px; max-width: 200px;" border="0">
                                        </td>
                                        <td bgcolor="#ffffff" align="right" class="mobile-hide">
                                            <span style="font-size: 12px; font-family: 'Open Sans', 'Helvetica Neue', Helvetica, Arial, sans-serif; color: #8a8f98;">Welcome!<br>Complete your <? GetScopeSpecificPreheader(); ?> account setup.</span>
                                        </td>
                                    </tr>
                                </table>
                            </td>
                        </tr>
                    </table>
                </div>
            </td>
        </tr>
    </table>

    <!-- BODY -->
    <table border="0" cellpadding="0" cellspacing="0" width="100%" bgcolor="#f4f5f7" style="background: #f4f5f7;">
        <tr>
            <td align="center" style="padding: 0 15px 40px 15px;">
                <table border="0" cellpadding="0" cellspacing="0" width="580" class="wrapper">

                    <!-- MASTHEAD -->
                    <tr>
                        <td align="center" style="background: <? GetPrimaryCss(); ?>; border-radius: 8px 8px 0 0; padding: 34px 20px;">
                            <h1 style="font-size: 26px; font-family: 'Montserrat', 'Helvetica Neue', Helvetica, Arial, sans-serif; line-height: 1.25; color: #ffffff; text-transform: uppercase; letter-spacing: 1px; margin: 0; padding: 0;">Welcome!</h1>
                        </td>
                    </tr>

                    <!-- GREETING + ACCOUNT INFO -->
                    <tr>
                        <td bgcolor="#ffffff" style="background: #ffffff; padding: 32px 35px 10px 35px;">
                            <h2 style="font-size: 22px; font-family: 'Open Sans', 'Helvetica Neue', Helvetica, Arial, sans-serif; line-height: 1.25; color: #1c1e21; margin: 0 0 14px; padding: 0;"><? GetUserName(); ?>,</h2>
                            <p style="font-size: 15px; font-family: 'Open Sans', 'Helvetica Neue', Helvetica, Arial, sans-serif; line-height: 1.65; color: #444444; font-weight: normal; margin: 0 0 22px; padding: 0;"><? GetScopeSpecificMessage(); ?> Here's your account information:</p>

                            <!-- account information card -->
                            <table border="0" cellspacing="0" cellpadding="0" width="100%" style="margin: 0 0 8px 0; background: #f8f9fb; border: 1px solid #e7e9ee; border-radius: 8px;">
                                <tr>
                                    <td style="padding: 18px 22px 14px 22px;">
                                        <table border="0" cellspacing="0" cellpadding="0" width="100%">
                                            <tr>
                                                <td align="left" style="padding: 0 0 2px 0; font-size: 11px; font-family: 'Open Sans', 'Helvetica Neue', Helvetica, Arial, sans-serif; font-weight: bold; letter-spacing: 1px; text-transform: uppercase; color: #9aa0a9;" class="padding-meta">Login</td>
                                            </tr>
                                            <tr>
                                                <td align="left" style="padding: 0 0 14px 0; font-size: 20px; font-family: 'Open Sans', 'Helvetica Neue', Helvetica, Arial, sans-serif; font-weight: normal; color: #1c1e21;" class="padding-copy"><a href="" style="text-decoration: none; color: #1c1e21; border: none;"><? GetLogin(); ?></a></td>
                                            </tr>
                                            <tr>
                                                <td align="left" style="padding: 0 0 2px 0; font-size: 11px; font-family: 'Open Sans', 'Helvetica Neue', Helvetica, Arial, sans-serif; font-weight: bold; letter-spacing: 1px; text-transform: uppercase; color: #9aa0a9;" class="padding-meta">Extension</td>
                                            </tr>
                                            <tr>
                                                <td align="left" style="padding: 0 0 14px 0; font-size: 20px; font-family: 'Open Sans', 'Helvetica Neue', Helvetica, Arial, sans-serif; font-weight: normal; color: #1c1e21;" class="padding-copy"><a href="" style="text-decoration: none; color: #1c1e21; border: none;"><? GetUser(); ?></a></td>
                                            </tr>
                                            <tr style="display: <? GetDID(); ?>">
                                                <td align="left" style="padding: 0 0 2px 0; font-size: 11px; font-family: 'Open Sans', 'Helvetica Neue', Helvetica, Arial, sans-serif; font-weight: bold; letter-spacing: 1px; text-transform: uppercase; color: #9aa0a9;" class="padding-meta">Phone Number</td>
                                            </tr>
                                            <tr style="display: <? GetDID(); ?>">
                                                <td align="left" style="padding: 0 0 14px 0; font-size: 20px; font-family: 'Open Sans', 'Helvetica Neue', Helvetica, Arial, sans-serif; font-weight: normal; color: #1c1e21;" class="padding-copy"><a href="" style="text-decoration: none; color: #1c1e21; border: none;"><? GetDID(); ?></a></td>
                                            </tr>
                                            <tr style="display: <? GetUserScope(); ?>">
                                                <td align="left" style="padding: 0 0 2px 0; font-size: 11px; font-family: 'Open Sans', 'Helvetica Neue', Helvetica, Arial, sans-serif; font-weight: bold; letter-spacing: 1px; text-transform: uppercase; color: #9aa0a9;" class="padding-meta">Scope</td>
                                            </tr>
                                            <tr style="display: <? GetUserScope(); ?>">
                                                <td align="left" style="padding: 0 0 4px 0; font-size: 20px; font-family: 'Open Sans', 'Helvetica Neue', Helvetica, Arial, sans-serif; font-weight: normal; color: #1c1e21;" class="padding-copy"><a href="" style="text-decoration: none; color: #1c1e21; border: none;"><? GetUserScope(); ?></a></td>
                                            </tr>
                                        </table>
                                    </td>
                                </tr>
                            </table>

                            <p style="font-size: 14px; font-family: 'Open Sans', 'Helvetica Neue', Helvetica, Arial, sans-serif; line-height: 1.65; color: #444444; font-weight: normal; margin: 0 0 12px; padding: 0;">Your account is set up with <strong>Reseller</strong> scope, and a new phone number has already been added to your domain's inventory &mdash; it's available for you to map to users, queues, or auto attendants as needed.</p>
                            <p style="font-size: 14px; font-family: 'Open Sans', 'Helvetica Neue', Helvetica, Arial, sans-serif; line-height: 1.65; color: #444444; font-weight: normal; margin: 0 0 8px; padding: 0;">Your new domain was created inside a pre-existing reseller that has been renamed to your company name. You'll find several other domains already in place under it with <strong>automated test traffic flowing</strong> &mdash; that's expected, and gives you realistic activity to explore from day one.</p>
                        </td>
                    </tr>

                    <!-- SETUP BUTTON -->
                    <tr>
                        <td bgcolor="#ffffff" style="background: #ffffff; padding: 14px 35px 6px 35px;">
                            <p style="font-size: 15px; font-family: 'Open Sans', 'Helvetica Neue', Helvetica, Arial, sans-serif; line-height: 1.65; color: #444444; font-weight: normal; margin: 0 0 20px; padding: 0;">Complete your account setup with the button below. You have <? GetResetExpiration(); ?> from the time this email was sent before the link expires.</p>
                            <table border="0" cellspacing="0" cellpadding="0" width="100%">
                                <tr>
                                    <td align="center" style="padding: 0 0 20px 0;">
                                        <a href="<? GetPasswordResetLink(); ?>" class="button" style="font-size: 16px; font-family: 'Open Sans', 'Helvetica Neue', Helvetica, Arial, sans-serif; line-height: 1.65; color: #ffffff; text-decoration: none; display: inline-block; font-weight: bold; border-radius: 6px; background: <? GetPrimaryCss(); ?>; margin: 0; padding: 0; border-color: <? GetPrimaryCss(); ?>; border-style: solid; border-width: 12px 28px 10px;">Complete Setup</a>
                                    </td>
                                </tr>
                            </table>
                            <p style="font-size: 13px; font-family: 'Open Sans', 'Helvetica Neue', Helvetica, Arial, sans-serif; line-height: 1.65; color: #8a8f98; font-weight: normal; margin: 0 0 6px; padding: 0;">If the button doesn't work, copy and paste this link into your browser:</p>
                            <p style="font-size: 13px; font-family: 'Courier New', Courier, monospace; line-height: 1.5; color: #555555; word-break: break-all; margin: 0 0 24px; padding: 0;"><? GetPasswordResetLink(); ?></p>
                        </td>
                    </tr>

                    <!-- WAYS TO CONNECT -->
                    <tr>
                        <td bgcolor="#ffffff" style="background: #ffffff; padding: 0 35px 8px 35px;">
                            <table border="0" cellspacing="0" cellpadding="0" width="100%" style="border-top: 1px solid #e7e9ee;">
                                <tr>
                                    <td style="padding: 26px 0 4px 0;">
                                        <h3 style="font-size: 16px; font-family: 'Open Sans', 'Helvetica Neue', Helvetica, Arial, sans-serif; line-height: 1.25; color: #1c1e21; margin: 0 0 4px; padding: 0;">Ways to access your environment</h3>
                                        <p style="font-size: 13px; font-family: 'Open Sans', 'Helvetica Neue', Helvetica, Arial, sans-serif; line-height: 1.6; color: #8a8f98; margin: 0 0 16px; padding: 0;">Once your password is set, the same login works everywhere below.</p>
                                    </td>
                                </tr>
                            </table>

                            <!-- Horizon -->
                            <table border="0" cellspacing="0" cellpadding="0" width="100%" style="margin: 0 0 10px 0; background: #f8f9fb; border: 1px solid #e7e9ee; border-radius: 8px;">
                                <tr>
                                    <td style="padding: 14px 22px 12px 22px;">
                                        <p style="font-size: 14px; font-family: 'Open Sans', 'Helvetica Neue', Helvetica, Arial, sans-serif; line-height: 1.5; color: #1c1e21; font-weight: bold; margin: 0 0 2px; padding: 0;">Horizon <span style="font-weight: normal; color: #8a8f98;">&mdash; the new web experience</span></p>
                                        <p style="font-size: 13px; font-family: 'Courier New', Courier, monospace; line-height: 1.5; word-break: break-all; margin: 0 0 2px; padding: 0;"><a href="https://<? GetFQDN(); ?>/horizon" style="color: #2374e1; text-decoration: none;">https://<? GetFQDN(); ?>/horizon</a></p>
                                        <p style="font-size: 13px; font-family: 'Courier New', Courier, monospace; line-height: 1.5; word-break: break-all; margin: 0; padding: 0;"><a href="https://<? GetFQDN(); ?>/auth/?r=horizon" style="color: #2374e1; text-decoration: none;">https://<? GetFQDN(); ?>/auth/?r=horizon</a></p>
                                    </td>
                                </tr>
                            </table>

                            <!-- SDK SAMPLE APPS -->
                            <table border="0" cellspacing="0" cellpadding="0" width="100%" style="margin: 0 0 10px 0; background: #f8f9fb; border: 1px solid #e7e9ee; border-radius: 8px;">
                                <tr>
                                    <td style="padding: 14px 22px 12px 22px;">
                                        <p style="font-size: 14px; font-family: 'Open Sans', 'Helvetica Neue', Helvetica, Arial, sans-serif; line-height: 1.5; color: #1c1e21; font-weight: bold; margin: 0 0 2px; padding: 0;">SDK Sample Apps <span style="font-weight: normal; color: #8a8f98;">&mdash; starting points for your own build</span></p>
                                        <p style="font-size: 13px; font-family: 'Courier New', Courier, monospace; line-height: 1.5; word-break: break-all; margin: 0 0 2px; padding: 0;">Horizon SDK demo: <a href="https://github.com/netsapiens/horizon-sdk-demo" style="color: #2374e1; text-decoration: none;">github.com/netsapiens/horizon-sdk-demo</a></p>
                                        <p style="font-size: 13px; font-family: 'Courier New', Courier, monospace; line-height: 1.5; word-break: break-all; margin: 0 0 2px; padding: 0;">SDK README: <a href="https://github.com/netsapiens/horizon-sdk-demo/blob/main/README.md" style="color: #2374e1; text-decoration: none;">github.com/netsapiens/horizon-sdk-demo/blob/main/README.md</a></p>
                                        <p style="font-size: 13px; font-family: 'Courier New', Courier, monospace; line-height: 1.5; word-break: break-all; margin: 0 0 2px; padding: 0;">NPM package: <a href="https://www.npmjs.com/package/@netsapiens/horizon-sdk" style="color: #2374e1; text-decoration: none;">npmjs.com/package/@netsapiens/horizon-sdk</a></p>
                                        <p style="font-size: 13px; font-family: 'Courier New', Courier, monospace; line-height: 1.5; word-break: break-all; margin: 0; padding: 0;">Demo app with auth: <a href="https://github.com/aaker/demoAppWithAuth" style="color: #2374e1; text-decoration: none;">github.com/aaker/demoAppWithAuth</a></p>
                                    </td>
                                </tr>
                            </table>

                            <!-- Manager Portal -->
                            <table border="0" cellspacing="0" cellpadding="0" width="100%" style="margin: 0 0 10px 0; background: #f8f9fb; border: 1px solid #e7e9ee; border-radius: 8px;">
                                <tr>
                                    <td style="padding: 14px 22px 12px 22px;">
                                        <p style="font-size: 14px; font-family: 'Open Sans', 'Helvetica Neue', Helvetica, Arial, sans-serif; line-height: 1.5; color: #1c1e21; font-weight: bold; margin: 0 0 2px; padding: 0;">Manager Portal <span style="font-weight: normal; color: #8a8f98;">&mdash; classic administration</span></p>
                                        <p style="font-size: 13px; font-family: 'Courier New', Courier, monospace; line-height: 1.5; word-break: break-all; margin: 0; padding: 0;"><a href="https://<? GetFQDN(); ?>/portal/" style="color: #2374e1; text-decoration: none;">https://<? GetFQDN(); ?>/portal/</a></p>
                                    </td>
                                </tr>
                            </table>

                            <!-- API -->
                            <table border="0" cellspacing="0" cellpadding="0" width="100%" style="margin: 0 0 24px 0; background: #f8f9fb; border: 1px solid #e7e9ee; border-radius: 8px;">
                                <tr>
                                    <td style="padding: 14px 22px 12px 22px;">
                                        <p style="font-size: 14px; font-family: 'Open Sans', 'Helvetica Neue', Helvetica, Arial, sans-serif; line-height: 1.5; color: #1c1e21; font-weight: bold; margin: 0 0 2px; padding: 0;">API <span style="font-weight: normal; color: #8a8f98;">&mdash; build and automate</span></p>
                                        <p style="font-size: 13px; font-family: 'Courier New', Courier, monospace; line-height: 1.5; word-break: break-all; margin: 0 0 2px; padding: 0;">Base URL: <a href="https://<? GetFQDN(); ?>/ns-api/v2/" style="color: #2374e1; text-decoration: none;">https://<? GetFQDN(); ?>/ns-api/v2/</a></p>
                                        <p style="font-size: 13px; font-family: 'Courier New', Courier, monospace; line-height: 1.5; word-break: break-all; margin: 0; padding: 0;">Docs: <a href="https://<? GetFQDN(); ?>/ns-api/docs" style="color: #2374e1; text-decoration: none;">https://<? GetFQDN(); ?>/ns-api/docs</a></p>
                                    </td>
                                </tr>
                            </table>
                        </td>
                    </tr>

                    <!-- BETA NOTICE -->
                    <tr>
                        <td bgcolor="#ffffff" style="background: #ffffff; border-radius: 0 0 8px 8px; padding: 0 35px 30px 35px;">
                            <table border="0" cellspacing="0" cellpadding="0" width="100%" style="background: #fff8e6; border: 1px solid #f0dfae; border-radius: 8px;">
                                <tr>
                                    <td style="padding: 14px 22px;">
                                        <p style="font-size: 12px; font-family: 'Open Sans', 'Helvetica Neue', Helvetica, Arial, sans-serif; line-height: 1.6; color: #7a6520; margin: 0; padding: 0;"><strong>Reminder:</strong> this is an early-access test environment provided with no SLA, and <strong>911 emergency services are not available</strong>. Do not rely on this system for emergency calling.</p>
                                    </td>
                                </tr>
                            </table>
                        </td>
                    </tr>

                    <!-- FOOTER -->
                    <tr>
                        <td align="center" style="padding: 26px 35px 0 35px;">
                            <p style="font-size: 13px; font-family: 'Open Sans', 'Helvetica Neue', Helvetica, Arial, sans-serif; line-height: 1.65; font-weight: normal; color: #888888; text-align: center; margin: 0; padding: 0;" align="center" class="appleFooter">If you have any trouble, please contact us by visiting our <a href="<? GetSupportLink(); ?>" style="color: #888888; text-decoration: underline; font-weight: bold;">support page</a>.</p>
                            <p style="font-size: 13px; font-family: 'Open Sans', 'Helvetica Neue', Helvetica, Arial, sans-serif; line-height: 1.65; font-weight: normal; color: #888888; text-align: center; margin: 0; padding: 0;" align="center" class="appleFooter">Sent by <a href="#" style="color: #888888; text-decoration: none; font-weight: bold;"><? GetPoweredBy(); ?></a></p>
                        </td>
                    </tr>

                </table>
            </td>
        </tr>
    </table>

</body>

</html>
