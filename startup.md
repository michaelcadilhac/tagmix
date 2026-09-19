You will be developing from scratch a webapp that does the following:
- It provides a searchable list of the tags available on barbershoptags.com.  Only the tags having the 4 learning tracks for the 4 parts should be listed.
- When a tag is selected, it is loaded as follows:
  - The sheet music is displayed.  To display the sheet music, the file on barbershoptags.com should be fetched, then rendered --- it is sometimes a PDF, sometimes another filetype.  The image should be cropped so that only the actual contents is displayed (i.e., if it's a full page in the PDF but only the top third contains music, only the top third is shown).
  - An interactive mixer is displayed with the 4 voices.  The MP3 for the voices may need pretreatment: It is common for them to have the voice on one of the stereo channels, and the other 3 on the other channel.  You need to extract the correct channel containing the voice, and create a stereo rendering of only that voice.  The interactive mixer will allow for mixing volume and left/right of each of the four tracks.  By default, bass is 70% on the left, baritone 60%, lead 40%, and tenor 20%, and conversely for the right channel.  The mixer should allow playing, and different playing speeds (0.25x, 0.5x, 0.75x, and 1x).  In a play bar, showing time progression in the play, the user should be able to create and delete marks, to return to the timestamp easily.

The webapp should be accessible on desktop and mobile devices.

Before starting, evaluate all the design choices that I did not specify, and ask me when the choice is not obvious.

On first completion, also create an AGENTS.md file containing a project description and programming guidelines for other agents to work on this project.

