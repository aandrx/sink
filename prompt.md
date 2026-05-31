im trying to create a plugin for the notetaking app obsidian
my goal is to have a livesync plugin that will be able to consistently sync my notes between my local machines and my "server". in this case, i have a home server (a 24/7 running linux desktop) that will take care of the "host" side of this project. that being said, this should be able to be run on any device- i should have it setup through some type of database (for example, couchDB) with a proper architecture for obsidian vaults. 

i have provided a full repository of the code for a obsidian-livesync plugin that already exists, but im trying to improve on this functionality, not necessarily completely copy this. im already using this for my daily use on one machine, but also have multiple machines that im struggling to get this working properly on. i can have it setup properly, but it doesnt actually maintain the syncing functionality, and especially not if im trying to have "live syncing" usage, to work kind of like google docs where it should be instant syncing (this is a paid option of obsidian, but im trying to do this for free). 

the process should start with setting up a database on the server side, then making sure its properly connected to the actual client machine with obsidian (through plugins), then do the syncing through there. make sure to include all the necessary security measures as well. 

in the repository that i have provided you, study this carefully to see how this already functioning obsidian plugin is working, then assess how to create this new "fork" somewhat of the project. make sure you end up with the proper output that has the correct files for me to properly install this obsidian plugin manually, and also name the project "sink". 

my biggest concerns when assessing this project:
- right now the configuration menu, setup/syncing setting process is way too complicated (theres a lot of terms there that arent explained, what things do, etc) and a lot of these are not used for a simple user 
- i just want it to work, in a more simple way, and just function for the more simple user. in general, id say the current process of the existing plugin is a complicated setup, and is not very easy to do in general
- make sure that a high priority of this is that the "livesync" part is a huge emphasis, and that it should be relatively quick- not to the point where you can instantly see typed letters, but at least after a line is typed, it should be a quick transfer to the other devices that are also livesynced. 
- this setup should not be operating system dependent, i have both windows, mac, and linux devices that are all using obsidian (even mobile, but not a priority) and should be able to livesync to each other. implement a similar way to setup the other livesyncs using something like a URI from the plugin, and also all those options of overwrriting the server database vs just copying the server to my local machine vault. 
- make sure that this is syncing a lot more often, its ok if theres more instances that trigger checking the server to update
- you can assume for this setup that this should only be working if you can directly access the host ip of the server- as in if youre on the same network, you could directly type in the ip of the server and access the db, etc. in my case, im using tailscale to have all my devices connected to my tailnet 24/7 so it should always be able to sync when necessary 
- are there other options for the database, is couchDB the best option, make decisions on this 

here is an example thread of some other users thoughts/complaints about the existing plugin.: 

the Livesync plugin is good alternative if you're on a budget but after using it for a month or so I realized there are bugs/quirks with it that just go away with the official (paid) sync (you get 10 notebooks for $8/mo). Here are a few problems that are a pain with Livesync but work out of the box with Obsidian Sync:

- plugin sync: livesync can now in theory do this but it has done more harm than good for me w/ this setting. I've had at least 2 occasions where my original plugins/config got overwritten/blown away with new device being added to the sync because livesync decided to use plugins from the new device as the source of truth instead of existing ones, even when I specifically asked to "fetch all remote settings to initialize this device".

- mobile sync: mobile will not auto-fetch updates if the app is in the background (e.g. you minimized it instead of turning it off, which is the default behavior on mobile). You need to physically close and restart the app or trigger sync manually to get mobile to sync, desktop does not seem to have this issue but also desyncs sometimes

- general bugginess: I occasionally have to go in the settings to reapply them if things stop syncing, I've had the plugin switch to "events" sync instead of livesync, I believe there are certain sync actions user can trigger that cause this.

Basically the question boils down to this:
- if you don't mind being the IT support for your notebook, Livesync is good enough
- if you're sharing the notebook with others and/or want things to just work, the extra $8/mo is worth the peace of mind

I have been using Livesync plugin for a few months and I am mostly happy with it. It is true that it requires som active work, but after already investing in a home server and looking for ways to save money using it, I think its well worth it. Over time I use less and less time maintaining it.

It a shame that it is so overly complicated. If I want to let others sync using my home server, I have to personally set it up on their devices because of how intuitive it is.

The project creater is actively developing it, which is great, but it does not seem making it more accessible is anything he prioritizes. At this point I feel like the plugin should be trimmed down to fit the usecase that applies for 95% of users and hide advanced settings by default. Its about time the community has a good self-hosted and easy-to-use alternative to the official Sync!
3


make decisions based on what you see fit of how this plugin could look like/function for my intended usage, and then output a fully fleshed out plan with a good idea on how this existing plugin works already so that i can set this up cleanly
