/* HD Dashboards — engineer master list.
   Every engineering (LRPS) assignee and the module they work under, so every user of the application gets the same list
   without entering anything. Used by the "Assignee's module missing in Components" check (Swire module and Follow-up
   Tracker) and to flag new assignees who are not in this list yet.

   How to update: Follow-up Tracker › Gaps › "Download engineering assignees", fill the Module column, and send the file
   to be turned into this list. Names are written as Jira shows the LRPS assignee; small differences (dots, spaces,
   a trailing initial) are matched. Module names are the ones in Swire › Master data (NFR, VSS, PNC, Export, Import,
   OPS, EMS, CMR, EDI, CVP, Release, DB …). */
window.HD_ENGINEERS = {
  /* "Balamurugan.R": "EMS", */
};
